import { hasScope, type Principal } from "../auth";
import { sha256Hex } from "../auth";
import { TOOL_BY_NAME, type AiBinding, type D1Like } from "@rel/core";
import { z } from "zod";
import { handlers } from "./handlers";

export interface DispatchResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** HTTP status for REST surfaces: 403 for authority, 400 for a bad request. */
  status?: number;
  meta?: { tool: string; scope: string; duration_ms: number; band?: string };
}

/**
 * One dispatch path for MCP, REST and the CLI. Validation, scope enforcement and
 * the call log all live here so no surface can drift from the others.
 */
export async function callTool(opts: {
  db: D1Like;
  principal: Principal;
  name: string;
  args: unknown;
  paused?: boolean;
  ai?: AiBinding | null;
}): Promise<DispatchResult> {
  const started = Date.now();
  const { db, principal, name } = opts;

  const log = async (status: "ok" | "denied" | "error", detail = "") => {
    try {
      await db
        .prepare(
          `INSERT INTO agent_calls (agent_key_id, tool, args_digest, status, duration_ms, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          principal.agentId,
          name,
          await sha256Hex(JSON.stringify(opts.args ?? {})),
          status,
          Date.now() - started,
          detail.slice(0, 300),
          new Date().toISOString(),
        )
        .run();
    } catch {
      // Never let the observability path break the call itself.
    }
  };

  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    await log("error", "unknown tool");
    return { ok: false, error: `unknown tool: ${name}`, status: 400 };
  }

  if (opts.paused && principal.kind === "agent") {
    await log("denied", "agents paused");
    return { ok: false, error: "agents are paused — a human turned agent access off", status: 403 };
  }

  if (tool.scope === "write" && !hasScope(principal, "write")) {
    await log("denied", "missing write scope");
    return { ok: false, error: `this key has no write scope, so ${name} was denied`, status: 403 };
  }

  const parsed = z.object(tool.input).safeParse(opts.args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    await log("error", detail);
    return { ok: false, error: `invalid input — ${detail}`, status: 400 };
  }

  try {
    const result = await handlers[name]!(
      {
        db,
        now: new Date().toISOString(),
        agent:
          principal.kind === "agent" ? { id: principal.agentId!, name: principal.name, scopes: principal.scopes } : null,
        ai: opts.ai ?? null,
      },
      parsed.data as Record<string, unknown>,
    );

    // A handler reporting `{ error }` is a failure, not a successful payload —
    // otherwise an agent sees ok:true and reports the error as data.
    const reported = (result as { error?: unknown } | null)?.error;
    if (typeof reported === "string" && reported.trim()) {
      await log("error", reported);
      return { ok: false, error: reported, status: 400 };
    }

    const band = (result as { band?: string } | null)?.band;
    await log("ok");
    return {
      ok: true,
      result,
      meta: { tool: name, scope: tool.scope, duration_ms: Date.now() - started, ...(band ? { band } : {}) },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("error", message);
    return { ok: false, error: message, status: 500 };
  }
}
