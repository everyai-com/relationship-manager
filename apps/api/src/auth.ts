import { createAuth } from "./auth-better";
import type { Env } from "./env";

export type { Env };

export interface Principal {
  kind: "human" | "agent";
  name: string;
  scopes: string;
  agentId: number | null;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Length-independent comparison for digests. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/**
 * One place decides who is calling.
 *
 * Humans are Better Auth sessions (a real account, a row in `session`). Agents
 * are Bearer keys with their own scopes, and they are deliberately a different
 * kind of principal: revocable, logged, and unable to send anything.
 */
export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const token = bearerToken(req);
  if (token?.startsWith("rel_")) {
    const keyHash = await sha256Hex(token);
    const row = await env.DB.prepare("SELECT id, name, scopes, revoked_at FROM agent_keys WHERE key_hash = ?")
      .bind(keyHash)
      .first<{ id: number; name: string; scopes: string; revoked_at: string | null }>();
    if (!row || row.revoked_at) return null;
    await env.DB.prepare("UPDATE agent_keys SET last_seen_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return { kind: "agent", name: row.name, scopes: row.scopes, agentId: row.id };
  }

  const session = await currentSession(req, env);
  if (session) {
    return { kind: "human", name: session.user.email, scopes: "read,write", agentId: null };
  }
  return null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function currentSession(req: Request, env: Env): Promise<{ user: SessionUser } | null> {
  if (!env.BETTER_AUTH_SECRET) return null;
  try {
    const session = await createAuth(env, new URL(req.url).origin).api.getSession({ headers: req.headers });
    if (session?.user?.email) {
      return { user: { id: session.user.id, email: session.user.email, name: session.user.name ?? "" } };
    }
  } catch {
    // An unreadable cookie is simply "not signed in".
  }
  return null;
}

export function hasScope(principal: Principal, scope: "read" | "write"): boolean {
  return principal.scopes.split(",").map((s) => s.trim()).includes(scope);
}

export async function agentsPaused(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'agents_paused'").first<{ value: string }>();
  return row?.value === "true";
}

export function newAgentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `rel_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export { safeEqual };
