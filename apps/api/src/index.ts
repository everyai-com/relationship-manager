import { TOOLS, signatureLine, type AiBinding, type D1Like } from "@rel/core";
import { DEFAULT_AI_MODEL, aiFrom } from "./ai";
import { ComposioError } from "./composio";
import { createAuth } from "./auth-better";
import { agentsPaused, authenticate, currentSession, newAgentKey, sha256Hex, type Principal } from "./auth";
import {
  chatResponse,
  createThread,
  deleteThread,
  getMessages,
  getThread,
  listThreads,
  titleFrom,
} from "./chat";
import { connectionsPayload } from "./connections";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { callTool } from "./tools/dispatch";
import { sourcesPayload, sourceAccount, sourceConnect, sourceDisconnect, sourceSync, sourceUpdate } from "./sources";
import { applySync, type SyncPayload } from "./sync";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

const unauthorized = () =>
  json({ error: "Sign in required" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="relationship-manager"' } });

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/mcp" || path.startsWith("/mcp/")) return mcpRoute(req, env);
    if (path.startsWith("/api/")) return apiRoute(req, env, url);

    // Everything else is the SPA. The UI authenticates against /api/session and
    // renders its own sign-in screen, so no HTML is gated here.
    return env.ASSETS.fetch(req);
  },

  /**
   * Connected accounts refresh themselves once a day. It is the same pull the
   * Sync now button runs, through the same ingestion path — the only difference
   * is that nobody is watching, so a failure is logged and the graph keeps the
   * freshness it can prove.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sourceSync(env, env.DB as unknown as D1Like)
        .then((result) => {
          if (result.results.length > 0 || result.errors.length > 0) {
            console.log(
              `scheduled sync: ${result.results.length} account(s) pulled, ${result.errors.length} skipped` +
                (result.errors.length ? ` — ${result.errors.map((issue) => `${issue.toolkit}: ${issue.error}`).join("; ")}` : ""),
            );
          }
        })
        .catch((issue) => {
          console.log(`scheduled sync skipped: ${issue instanceof Error ? issue.message : String(issue)}`);
        }),
    );
  },
} satisfies ExportedHandler<Env>;

async function mcpRoute(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      },
    });
  }
  const principal = await authenticate(req, env);
  if (!principal) return unauthorized();
  const res = await handleMcp(req, env, principal, aiFrom(env));
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
}

async function apiRoute(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = req.method.toUpperCase();

  // ---- Better Auth owns /api/auth/* (sign-up, sign-in, sign-out, session) ---
  if (path.startsWith("/api/auth") && env.BETTER_AUTH_SECRET) {
    try {
      return await createAuth(env, url.origin).handler(req);
    } catch (error) {
      // A 1101 with no detail is impossible to debug from outside, so the cause
      // is logged and echoed. This deployment is private and single-owner.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`auth handler failed: ${message}`);
      return json({ error: "auth failed", detail: message }, { status: 500 });
    }
  }

  if (path === "/api/session" && method === "GET") {
    const principal = await authenticate(req, env);
    const session = await currentSession(req, env);
    return json({
      authed: Boolean(principal),
      kind: principal?.kind ?? null,
      name: principal?.name ?? null,
      scopes: principal?.scopes ?? null,
      configured: Boolean(env.BETTER_AUTH_SECRET),
      app: env.APP_NAME ?? "Relationship Manager",
      signature: signatureLine(),
      model: env.AI ? (env.AI_MODEL ?? DEFAULT_AI_MODEL) : null,
      account: session ? { email: session.user.email, name: session.user.name } : null,
      signupOpen: Boolean(env.ALLOWED_EMAILS?.trim()),
    });
  }

  // ---- everything below needs a caller -------------------------------------
  const principal = await authenticate(req, env);
  if (!principal) return unauthorized();

  if (path === "/api/overview" && method === "GET") return overview(env, principal);

  if (path === "/api/tools" && method === "GET") {
    return json({
      tools: TOOLS.map((t) => ({
        name: t.name,
        scope: t.scope,
        description: t.description,
        args: Object.keys(t.input),
      })),
    });
  }

  if (path.startsWith("/api/tools/") && method === "POST") {
    const name = path.slice("/api/tools/".length);
    const body = await readJson<Record<string, unknown>>(req);
    const paused = await agentsPaused(env);
    const res = await callTool({ db: env.DB, principal, name, args: body ?? {}, paused, ai: aiFrom(env) });
    return json(res, { status: res.ok ? 200 : (res.status ?? 400) });
  }

  if (path === "/api/agents" && method === "GET") {
    const keys = await env.DB.prepare(
      "SELECT id, name, scopes, created_at, last_seen_at, revoked_at FROM agent_keys ORDER BY created_at DESC",
    ).all();
    const paused = await agentsPaused(env);
    return json({ keys: keys.results ?? [], paused });
  }

  if (path === "/api/agents" && method === "POST") {
    if (principal.kind === "agent") return json({ error: "agents cannot mint keys" }, { status: 403 });
    const body = await readJson<{ name?: string; scopes?: string }>(req);
    const name = (body?.name ?? "").trim() || "Unnamed agent";
    const scopes = body?.scopes === "write" ? "read,write" : "read";
    const key = newAgentKey();
    await env.DB.prepare(
      "INSERT INTO agent_keys (name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(name, await sha256Hex(key), scopes, new Date().toISOString())
      .run();
    // The plaintext shows once. Only its hash is stored.
    return json({ key, name, scopes, note: "Copy this now — it is not stored and cannot be shown again." });
  }

  if (path.startsWith("/api/agents/") && method === "POST") {
    const rest = path.slice("/api/agents/".length);
    const [idRaw, action] = rest.split("/");
    const id = Number(idRaw);
    if (!Number.isFinite(id)) return json({ error: "bad agent id" }, { status: 400 });

    if (action === "revoke") {
      await env.DB.prepare("UPDATE agent_keys SET revoked_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), id)
        .run();
      return json({ ok: true });
    }
    if (action === "pause") {
      const body = await readJson<{ paused?: boolean }>(req);
      await env.DB.prepare(
        "INSERT INTO app_settings (key, value) VALUES ('agents_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
        .bind(body?.paused ? "true" : "false")
        .run();
      return json({ ok: true, paused: Boolean(body?.paused) });
    }
    return json({ error: "unknown action" }, { status: 404 });
  }

  if (path === "/api/agents/calls" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const rows = await env.DB.prepare(
      `SELECT c.*, k.name AS agent_name FROM agent_calls c
       LEFT JOIN agent_keys k ON k.id = c.agent_key_id
       ORDER BY c.created_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all();
    return json({ calls: rows.results ?? [] });
  }

  if (path === "/api/approvals" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100",
    ).all();
    return json({
      approvals: (rows.results ?? []).map((r) => ({
        ...r,
        payload: safeParse((r as { payload?: string }).payload),
      })),
    });
  }

  if (path.startsWith("/api/approvals/") && method === "POST") {
    const id = Number(path.slice("/api/approvals/".length));
    const body = await readJson<{ decision?: string }>(req);
    const decision = body?.decision === "approve" ? "approved" : body?.decision === "deny" ? "denied" : null;
    if (!decision || !Number.isFinite(id)) return json({ error: "decision must be approve or deny" }, { status: 400 });
    const row = await env.DB.prepare("SELECT id, status FROM approvals WHERE id = ?").bind(id).first<{ id: number; status: string }>();
    if (!row) return json({ error: "not found" }, { status: 404 });
    if (row.status !== "pending") return json({ error: "already decided" }, { status: 409 });
    await env.DB.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?")
      .bind(decision, new Date().toISOString(), id)
      .run();
    return json({ ok: true, status: decision });
  }

  if (path === "/api/connections" && method === "GET") {
    return json(await connectionsPayload(env.DB, new Date().toISOString()));
  }

  // ---- Sources: the accounts behind the graph, and the pulls from them -------
  if (path === "/api/sources" && method === "GET") {
    return json(await sourcesPayload(env, env.DB as unknown as D1Like));
  }

  if (path === "/api/sources/connect" && method === "POST") {
    const body = await readJson<{ toolkit?: string }>(req);
    if (!body?.toolkit) return json({ error: "toolkit is required" }, { status: 400 });
    try {
      const started = await sourceConnect(env, env.DB as unknown as D1Like, body.toolkit, url.origin);
      return json(started);
    } catch (issue) {
      const status = issue instanceof ComposioError ? issue.status : 502;
      return json({ error: issue instanceof Error ? issue.message : String(issue) }, { status });
    }
  }

  if (path === "/api/sources/sync" && method === "POST") {
    const body = await readJson<{ toolkit?: string }>(req);
    try {
      return json(await sourceSync(env, env.DB as unknown as D1Like, body?.toolkit));
    } catch (issue) {
      const status = issue instanceof ComposioError ? issue.status : 502;
      return json({ error: issue instanceof Error ? issue.message : String(issue) }, { status });
    }
  }

  if (path.startsWith("/api/sources/accounts/")) {
    const id = Number(path.slice("/api/sources/accounts/".length));
    if (!Number.isFinite(id) || id <= 0) return json({ error: "bad account id" }, { status: 400 });
    try {
      if (method === "GET") {
        return json({ account: await sourceAccount(env, env.DB as unknown as D1Like, id) });
      }
      if (method === "POST") {
        const body = await readJson<{ enabled?: boolean; is_default?: boolean }>(req);
        return json({ account: await sourceUpdate(env, env.DB as unknown as D1Like, id, body ?? {}) });
      }
      if (method === "DELETE") {
        await sourceDisconnect(env, env.DB as unknown as D1Like, id);
        return json({ ok: true });
      }
    } catch (issue) {
      const status = issue instanceof ComposioError ? issue.status : 502;
      return json({ error: issue instanceof Error ? issue.message : String(issue) }, { status });
    }
  }

  // ---- Ask: saved conversations with the graph -------------------------------
  if (path === "/api/chat/threads" && method === "GET") {
    return json({ threads: await listThreads(env.DB) });
  }

  if (path === "/api/chat/threads" && method === "POST") {
    const body = await readJson<{ person_id?: number }>(req);
    const wanted = Number(body?.person_id);
    const personId = Number.isFinite(wanted) && wanted > 0 ? wanted : null;
    const thread = await createThread(env.DB, new Date().toISOString(), personId);
    return json({ thread });
  }

  if (path.startsWith("/api/chat/threads/")) {
    const id = Number(path.slice("/api/chat/threads/".length));
    if (!Number.isFinite(id)) return json({ error: "bad thread id" }, { status: 400 });

    if (method === "GET") {
      const thread = await getThread(env.DB, id);
      if (!thread) return json({ error: "not found" }, { status: 404 });
      return json({ thread, messages: await getMessages(env.DB, id) });
    }
    if (method === "DELETE") {
      const removed = await deleteThread(env.DB, id);
      if (!removed) return json({ error: "not found" }, { status: 404 });
      return json({ ok: true });
    }
  }

  if (path === "/api/chat" && method === "POST") {
    const ai = aiFrom(env);
    if (!ai) return json({ error: "Workers AI is not configured on this deployment" }, { status: 503 });

    const body = await readJson<{ thread_id?: number; person_id?: number; question?: string }>(req);
    const question = (body?.question ?? "").trim();
    if (!question) return json({ error: "question is required" }, { status: 400 });
    if (question.length > 2000) return json({ error: "question is too long — 2000 characters max" }, { status: 400 });

    const now = new Date().toISOString();
    const wantedPerson = Number(body?.person_id);
    let personId = Number.isFinite(wantedPerson) && wantedPerson > 0 ? wantedPerson : null;

    const wantedThread = Number(body?.thread_id);
    let threadId = Number.isFinite(wantedThread) && wantedThread > 0 ? wantedThread : 0;

    if (threadId > 0) {
      const existing = await getThread(env.DB, threadId);
      if (!existing) return json({ error: "thread not found" }, { status: 404 });
      if (!personId && existing.person_id) personId = existing.person_id;
    } else {
      const thread = await createThread(env.DB, now, personId, titleFrom(question));
      if (!thread.id) return json({ error: "could not start a conversation" }, { status: 500 });
      threadId = thread.id;
    }

    return chatResponse({ db: env.DB, ai, now, threadId, personId, question });
  }

  // Raw source ingestion. Facts never travel this path — they go through record_fact.
  if (path === "/api/sync" && method === "POST") {
    const body = await readJson<SyncPayload>(req);
    if (!body?.source) return json({ error: "source is required" }, { status: 400 });
    const counts = await applySync(env.DB, body);
    return json({ ok: true, ...counts });
  }
  return json({ error: "Not found" }, { status: 404 });
}

async function overview(env: Env, principal: Principal): Promise<Response> {
  const db = env.DB as D1Like;
  const one = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;

  const [people, messages, meetings, proposed, reconnectReady, agents24h] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM people"),
    one("SELECT COUNT(*) AS n FROM messages"),
    one("SELECT COUNT(*) AS n FROM meetings"),
    one("SELECT COUNT(*) AS n FROM person_facts WHERE status = 'PROPOSED'"),
    one("SELECT COUNT(*) AS n FROM reconnect WHERE suppressed = 0 AND cohort_rank <= 30"),
    one("SELECT COUNT(*) AS n FROM agent_calls WHERE created_at >= ?", new Date(Date.now() - 86_400_000).toISOString()),
  ]);

  const due = await db
    .prepare(
      `SELECT id, person_id, channel, subject, followup_at, status FROM outreach
       WHERE followup_at IS NOT NULL AND followup_at <> '' AND followup_at <= ?
       ORDER BY followup_at ASC LIMIT 20`,
    )
    .bind(new Date().toISOString().slice(0, 10))
    .all();

  const stale = await db
    .prepare(
      "SELECT id, source, label, status, last_sync_at, item_count FROM connections WHERE status IN ('stale', 'error') ORDER BY source",
    )
    .all();

  const calls = await db
    .prepare(
      `SELECT c.id, c.tool, c.status, c.duration_ms, c.created_at, k.name AS agent_name
       FROM agent_calls c LEFT JOIN agent_keys k ON k.id = c.agent_key_id
       WHERE c.created_at >= ? ORDER BY c.created_at DESC LIMIT 12`,
      )
    .bind(new Date(Date.now() - 86_400_000).toISOString())
    .all();

  return json({
    caller: { kind: principal.kind, name: principal.name },
    counts: { people, messages, meetings, proposed, reconnectReady, agents24h },
    due: due.results ?? [],
    stale: stale.results ?? [],
    agent_calls: calls.results ?? [],
  });
}

function safeParse(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}
