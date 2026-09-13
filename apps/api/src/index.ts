import { TOOLS, signatureLine, type AiBinding, type D1Like } from "@rel/core";
import {
  agentsPaused,
  authenticate,
  clearedCookie,
  createSession,
  newAgentKey,
  passwordMatches,
  sessionCookie,
  sha256Hex,
  type Env,
  type Principal,
} from "./auth";
import { handleMcp } from "./mcp";
import { callTool } from "./tools/dispatch";

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

const DEFAULT_AI_MODEL = "@cf/zai-org/glm-5.3-flash";

/**
 * Workers AI, wrapped so the domain layer never sees the binding. If the binding
 * is absent the model-backed tools say so instead of failing obscurely.
 *
 * glm-5.3-flash is a *reasoning* model: it spends completion tokens on
 * `reasoning_content` before writing `content`, so the budget has to be
 * generous or the answer comes back empty. We keep thinking on — turning it off
 * makes the model leak its scratch work into the answer.
 */
function aiFrom(env: Env): AiBinding | null {
  const binding = env.AI;
  if (!binding) return null;
  const model = env.AI_MODEL && env.AI_MODEL.trim() ? env.AI_MODEL.trim() : DEFAULT_AI_MODEL;

  return {
    model,
    run: async ({ system, user }) => {
      const result = (await binding.run(model as never, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 2048,
        temperature: 0.2,
      } as never)) as unknown;

      const text = extractModelText(result).trim();
      if (!text) {
        throw new Error(
          `the model (${model}) returned no answer — it may have spent its whole budget reasoning. Try again, or ask a narrower question.`,
        );
      }
      return text;
    },
  };
}

/** Chat models return choices[].message.content; older text models return `response`. */
function extractModelText(result: unknown): string {
  if (typeof result === "string") return result;
  const value = result as
    | { response?: unknown; choices?: Array<{ message?: { content?: unknown }; text?: unknown }>; result?: { response?: unknown } }
    | null;
  if (!value) return "";
  if (typeof value.response === "string") return value.response;
  if (typeof value.result?.response === "string") return value.result.response;
  const choice = value.choices?.[0];
  if (choice) {
    if (typeof choice.message?.content === "string") return choice.message.content;
    if (typeof choice.text === "string") return choice.text;
  }
  return "";
}

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

  // ---- public: session lifecycle -------------------------------------------
  if (path === "/api/login" && method === "POST") {
    const body = await readJson<{ password?: string }>(req);
    if (!env.LOGIN_PASSWORD || !env.SESSION_SECRET) {
      return json({ error: "This deployment has no password configured yet." }, { status: 503 });
    }
    if (!body?.password || !(await passwordMatches(env, body.password))) {
      return json({ error: "That password does not match." }, { status: 401 });
    }
    const value = await createSession(env.SESSION_SECRET);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(value) } });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearedCookie() } });
  }

  if (path === "/api/session" && method === "GET") {
    const principal = await authenticate(req, env);
    return json({
      authed: Boolean(principal),
      kind: principal?.kind ?? null,
      name: principal?.name ?? null,
      scopes: principal?.scopes ?? null,
      configured: Boolean(env.LOGIN_PASSWORD),
      app: env.APP_NAME ?? "Relationship Manager",
      signature: signatureLine(),
      model: env.AI ? (env.AI_MODEL ?? DEFAULT_AI_MODEL) : null,
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
    return json(res, { status: res.ok ? 200 : res.error?.includes("denied") ? 403 : 400 });
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

  // Raw source ingestion. Facts never travel this path — they go through record_fact.
  if (path === "/api/sync" && method === "POST") {
    const body = await readJson<SyncPayload>(req);
    if (!body?.source) return json({ error: "source is required" }, { status: 400 });
    const counts = await applySync(env.DB, body);
    return json({ ok: true, ...counts });
  }

  return json({ error: "Not found" }, { status: 404 });
}

interface SyncPayload {
  source: string;
  label?: string;
  status?: string;
  last_sync_at?: string;
  detail?: string;
  messages?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  meetings?: Array<Record<string, unknown>>;
}

async function applySync(db: D1Database, body: SyncPayload) {
  const now = new Date().toISOString();
  let inserted = 0;

  const statements: D1PreparedStatement[] = [];

  for (const m of body.messages ?? []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (id, service, thread_id, from_addr, to_addr, subject, snippet, body_text, labels, is_unread, last_from_user, internal_date, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(service, id) DO UPDATE SET thread_id=excluded.thread_id, from_addr=excluded.from_addr, to_addr=excluded.to_addr,
             subject=excluded.subject, snippet=excluded.snippet, body_text=excluded.body_text, labels=excluded.labels,
             is_unread=excluded.is_unread, last_from_user=excluded.last_from_user, internal_date=excluded.internal_date, synced_at=excluded.synced_at`,
        )
        .bind(
          String(m.id),
          String(m.service ?? body.source),
          m.thread_id ?? null,
          m.from_addr ?? null,
          m.to_addr ?? null,
          m.subject ?? null,
          m.snippet ?? null,
          m.body_text ?? null,
          String(m.labels ?? ""),
          m.is_unread ? 1 : 0,
          m.last_from_user ? 1 : 0,
          m.internal_date ?? null,
          now,
        ),
    );
  }

  for (const e of body.events ?? []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events (id, service, title, start_at, end_at, is_all_day, location, organizer, attendees, status, link, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(service, id) DO UPDATE SET title=excluded.title, start_at=excluded.start_at, end_at=excluded.end_at,
             location=excluded.location, organizer=excluded.organizer, attendees=excluded.attendees, status=excluded.status, link=excluded.link`,
        )
        .bind(
          String(e.id),
          String(e.service ?? body.source),
          e.title ?? null,
          e.start_at ?? null,
          e.end_at ?? null,
          e.is_all_day ? 1 : 0,
          e.location ?? null,
          e.organizer ?? null,
          String(e.attendees ?? ""),
          e.status ?? null,
          e.link ?? null,
          now,
        ),
    );
  }

  for (const m of body.meetings ?? []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO meetings (id, title, ended_at, attendees, summary, action_items, url)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, ended_at=excluded.ended_at, attendees=excluded.attendees,
             summary=excluded.summary, action_items=excluded.action_items, url=excluded.url`,
        )
        .bind(
          String(m.id),
          String(m.title ?? ""),
          m.endedAt ?? m.ended_at ?? null,
          JSON.stringify(m.attendees ?? []),
          String(m.summary ?? ""),
          JSON.stringify(m.actionItems ?? m.action_items ?? []),
          m.url ?? null,
        ),
    );
  }

  if (statements.length) {
    for (let i = 0; i < statements.length; i += 50) {
      const chunk = statements.slice(i, i + 50);
      await db.batch(chunk);
      inserted += chunk.length;
    }
  }

  await db
    .prepare(
      `INSERT INTO sync_log (source, pushed_at, inserted, updated, skipped, detail) VALUES (?, ?, ?, 0, 0, ?)`,
    )
    .bind(body.source, now, inserted, body.detail ?? "")
    .run();

  const total = (body.messages?.length ?? 0) + (body.events?.length ?? 0) + (body.meetings?.length ?? 0);
  await db
    .prepare(
      `INSERT INTO connections (id, source, label, status, last_sync_at, item_count, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, last_sync_at=excluded.last_sync_at,
         item_count=excluded.item_count, detail=excluded.detail`,
    )
    .bind(
      body.source,
      body.source,
      body.label ?? body.source,
      (body.status as string) ?? "connected",
      body.last_sync_at ?? now,
      total,
      body.detail ?? "",
    )
    .run();

  return { inserted };
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
