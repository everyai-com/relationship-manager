export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  AI_MODEL?: string;
  LOGIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  APP_NAME?: string;
}

export interface Principal {
  kind: "human" | "agent";
  name: string;
  scopes: string;
  agentId: number | null;
}

export const SESSION_COOKIE = "rel_session";
const SESSION_TTL_MS = 86_400_000;

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

/** Length-independent comparison for digests. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(value: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ].join("; ");
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(secret: string, ttlMs = SESSION_TTL_MS): Promise<string> {
  const expiry = Date.now() + ttlMs;
  const sig = await hmacHex(secret, String(expiry));
  return `${expiry}.${sig}`;
}

export async function verifySession(secret: string, value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const expiry = Number(value.slice(0, dot));
  const sig = value.slice(dot + 1);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  return safeEqual(sig, await hmacHex(secret, String(expiry)));
}

export async function passwordMatches(env: Env, supplied: string): Promise<boolean> {
  if (!env.LOGIN_PASSWORD) return false;
  return safeEqual(await sha256Hex(supplied), await sha256Hex(env.LOGIN_PASSWORD));
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/**
 * One place decides who is calling. The human session gets everything; an agent
 * key gets exactly the scopes it was issued with.
 */
export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const token = bearerToken(req);
  if (token?.startsWith("rel_")) {
    const keyHash = await sha256Hex(token);
    const row = await env.DB.prepare(
      "SELECT id, name, scopes, revoked_at FROM agent_keys WHERE key_hash = ?",
    )
      .bind(keyHash)
      .first<{ id: number; name: string; scopes: string; revoked_at: string | null }>();
    if (!row || row.revoked_at) return null;
    await env.DB.prepare("UPDATE agent_keys SET last_seen_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return { kind: "agent", name: row.name, scopes: row.scopes, agentId: row.id };
  }

  if (env.SESSION_SECRET) {
    const cookies = parseCookies(req.headers.get("Cookie"));
    if (await verifySession(env.SESSION_SECRET, cookies[SESSION_COOKIE])) {
      return { kind: "human", name: "you", scopes: "read,write", agentId: null };
    }
  }
  return null;
}

export function hasScope(principal: Principal, scope: "read" | "write"): boolean {
  return principal.scopes.split(",").map((s) => s.trim()).includes(scope);
}

export async function agentsPaused(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'agents_paused'")
    .first<{ value: string }>();
  return row?.value === "true";
}

export function newAgentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `rel_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
