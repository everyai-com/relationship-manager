import type { D1Like } from "@rel/core";
import type { Env } from "./env";

/**
 * Composio, from the Worker.
 *
 * The connect flow is the one proven in the AIOS dashboard
 * (`wt-core-pr37-audit/src/connectors/composio.ts`): one managed auth config per
 * toolkit, then `POST /connected_accounts/link` for the user to sign in — with
 * the raw `/connected_accounts` call kept as a fallback while Composio retires
 * it. Tool execution is the same three-part contract our Python connector uses
 * (toolkit version, an ACTIVE account, and that account's own user id).
 *
 * Nothing here pretends a connection exists: an unfinished sign-in stays
 * pending, and a missing key says so instead of failing obscurely.
 */

const BASE = "https://backend.composio.dev/api/v3";

export class ComposioError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface ComposioAccount {
  id: string;
  toolkit: string;
  status: string;
  userId: string;
  label: string;
  alias: string | null;
}

/** What the graph can actually read, and how it says so on screen. */
export interface ToolkitSpec {
  slug: string;
  source: string;
  label: string;
  reads: string;
}

export const TOOLKITS: ToolkitSpec[] = [
  {
    slug: "gmail",
    source: "gmail",
    label: "Gmail",
    reads: "Messages and threads — who writes to you, and who you actually answer.",
  },
  {
    slug: "googlecalendar",
    source: "google-calendar",
    label: "Google Calendar",
    reads: "Events and attendees — the people you meet with, not just the ones who email.",
  },
  {
    slug: "fathom",
    source: "fathom",
    label: "Fathom",
    reads: "Recorded calls with attendees, summaries and action items.",
  },
];

export function toolkitFor(value: string): ToolkitSpec | null {
  const wanted = value.trim().toLowerCase();
  return TOOLKITS.find((toolkit) => toolkit.slug === wanted || toolkit.source === wanted) ?? null;
}

export function composioConfigured(env: Env): boolean {
  return Boolean(env.COMPOSIO_API_KEY && env.COMPOSIO_API_KEY.trim());
}

async function composioFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const key = env.COMPOSIO_API_KEY?.trim();
  if (!key) throw new ComposioError("COMPOSIO_API_KEY is not set on this deployment", 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "x-api-key": key, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new ComposioError(
      `Composio could not be reached (${error instanceof Error ? error.message : String(error)})`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function composioJson(env: Env, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await composioFetch(env, path, init);
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ComposioError("Composio rejected the API key", 502);
    }
    throw new ComposioError(
      `Composio ${path} failed (${response.status})${text ? `: ${text.slice(0, 240)}` : ""}`,
      502,
    );
  }
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new ComposioError(`Composio ${path} returned something that is not JSON`, 502);
  }
}

/* ---- auth configs ---- */

/**
 * One managed auth config per toolkit, created on first connect and remembered,
 * so a second account is a sign-in and not another config.
 */
export async function ensureAuthConfig(env: Env, db: D1Like, toolkit: string): Promise<string> {
  const stored = await db
    .prepare("SELECT auth_config_id FROM toolkit_auth_configs WHERE toolkit = ?")
    .bind(toolkit)
    .first<{ auth_config_id: string }>();
  if (stored?.auth_config_id) return stored.auth_config_id;

  const query = new URLSearchParams({ toolkit_slug: toolkit, is_composio_managed: "true" });
  const existing = await composioJson(env, `/auth_configs?${query.toString()}`);
  const first = asArray(existing.items)[0];
  let authConfigId = String(asRecord(first).id ?? asRecord(first).nanoid ?? "");

  if (!authConfigId) {
    const created = await composioJson(env, "/auth_configs", {
      method: "POST",
      body: JSON.stringify({
        toolkit: { slug: toolkit },
        auth_config: { type: "use_composio_managed_auth", name: `relationship-manager-${toolkit}` },
      }),
    }).catch((error: unknown) => {
      if (error instanceof ComposioError && error.status === 502) {
        throw new ComposioError(
          `${toolkit} needs its own OAuth developer app before it can be connected here — Composio refused to create a managed auth config (${error.message.slice(0, 160)})`,
          400,
        );
      }
      throw error;
    });
    authConfigId = String(asRecord(created.auth_config).id ?? created.id ?? created.nanoid ?? "");
  }

  if (!authConfigId) throw new ComposioError(`Composio returned no auth config for ${toolkit}`, 502);

  await db
    .prepare(
      `INSERT INTO toolkit_auth_configs (toolkit, auth_config_id, managed, created_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(toolkit) DO UPDATE SET auth_config_id = excluded.auth_config_id`,
    )
    .bind(toolkit, authConfigId, new Date().toISOString())
    .run();

  return authConfigId;
}

/* ---- accounts ---- */

function accountFrom(value: unknown): ComposioAccount | null {
  const item = asRecord(value);
  const id = String(item.id ?? item.nanoid ?? "");
  if (!id) return null;
  const toolkit = String(asRecord(item.toolkit).slug ?? item.toolkit ?? "");
  const label = String(
    item.account_label ??
      item.accountLabel ??
      item.account_email ??
      item.accountEmail ??
      item.email ??
      asRecord(item.params).email ??
      asRecord(item.metadata).email ??
      item.word_id ??
      item.account_id ??
      "",
  );
  return {
    id,
    toolkit,
    status: String(item.status ?? item.state ?? "PENDING").toUpperCase(),
    userId: String(item.user_id ?? item.userId ?? ""),
    label,
    alias: typeof item.alias === "string" ? item.alias : null,
  };
}

export async function listAccounts(env: Env): Promise<ComposioAccount[]> {
  const body = await composioJson(env, "/connected_accounts?limit=100");
  return asArray(body.items).map(accountFrom).filter((account): account is ComposioAccount => account !== null);
}

export async function getAccount(env: Env, id: string): Promise<ComposioAccount | null> {
  const body = await composioJson(env, `/connected_accounts/${encodeURIComponent(id)}`);
  return accountFrom(body);
}

export async function removeAccount(env: Env, id: string): Promise<void> {
  const response = await composioFetch(env, `/connected_accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  // Already gone is the outcome we wanted.
  if (!response.ok && response.status !== 404) {
    throw new ComposioError(`Composio would not remove the account (${response.status})`, 502);
  }
}

/**
 * Start a sign-in. The modern link endpoint first; the raw create call is kept
 * as a fallback while Composio retires it (both AIOS implementations do this).
 */
export async function createConnectLink(
  env: Env,
  db: D1Like,
  toolkit: string,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectionId: string; redirectUrl: string | null; active: boolean }> {
  const authConfigId = await ensureAuthConfig(env, db, toolkit);

  const link = await composioFetch(env, "/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: userId,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    }),
  });

  if (link.ok) {
    const body = asRecord(await link.json().catch(() => ({})));
    const connectionId = String(body.connected_account_id ?? body.id ?? "");
    const redirectUrl = body.redirect_url ? String(body.redirect_url) : null;
    if (connectionId && (redirectUrl || body.status)) {
      const status = String(body.status ?? "").toUpperCase();
      return { connectionId, redirectUrl, active: status === "ACTIVE" || status === "CONNECTED" };
    }
  }

  // Fallback: the raw endpoint the SDK used to wrap.
  const created = await composioJson(env, "/connected_accounts", {
    method: "POST",
    body: JSON.stringify({ auth_config: { id: authConfigId }, connection: { user_id: userId } }),
  });
  const connectionId = String(created.id ?? created.connectedAccountId ?? created.connection_id ?? "");
  const redirectUrl = created.redirect_url ?? created.redirectUrl ?? created.authUrl ?? null;
  const status = String(created.status ?? "").toUpperCase();
  if (!connectionId) throw new ComposioError("Composio started no connection for this sign-in", 502);
  return { connectionId, redirectUrl: redirectUrl ? String(redirectUrl) : null, active: status === "ACTIVE" };
}

/* ---- tool execution ---- */

const versionCache = new Map<string, string>();

async function toolkitVersion(env: Env, toolkit: string): Promise<string> {
  const cached = versionCache.get(toolkit);
  if (cached) return cached;
  const body = await composioJson(env, `/toolkits/${encodeURIComponent(toolkit)}`);
  const versions = asArray(asRecord(body.meta).available_versions);
  const version = versions.length > 0 ? String(versions[0]) : "";
  if (!version) throw new ComposioError(`Composio exposes no version for ${toolkit}`, 502);
  versionCache.set(toolkit, version);
  return version;
}

export async function execute(
  env: Env,
  options: {
    slug: string;
    toolkit: string;
    account: ComposioAccount;
    arguments: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const version = await toolkitVersion(env, options.toolkit);
  const body = await composioJson(env, `/tools/execute/${options.slug}`, {
    method: "POST",
    body: JSON.stringify({
      user_id: options.account.userId,
      connected_account_id: options.account.id,
      version,
      arguments: options.arguments,
    }),
  });
  const data = body.data;
  if (data === undefined || data === null) {
    throw new ComposioError(`${options.slug} returned no data`, 502);
  }
  return asRecord(data);
}

/* ---- the pulls (same shapes the Python connector pushes) ---- */

export async function fetchGmail(
  env: Env,
  account: ComposioAccount,
  query: string,
  maxResults = 100,
): Promise<Array<Record<string, unknown>>> {
  const data = await execute(env, {
    slug: "GMAIL_FETCH_EMAILS",
    toolkit: "gmail",
    account,
    arguments: { query, max_results: maxResults },
  });

  const rows = asArray(data.messages).length > 0 ? asArray(data.messages) : asArray(data.items);
  const messages: Array<Record<string, unknown>> = [];
  for (const value of rows) {
    const row = asRecord(value);
    const id = String(row.messageId ?? row.id ?? row.threadId ?? "");
    if (!id) continue;
    const labels = Array.isArray(row.labelIds) ? row.labelIds : Array.isArray(row.labels) ? row.labels : [];
    messages.push({
      id,
      service: "gmail",
      thread_id: row.threadId ?? id,
      from_addr: row.sender ?? row.from ?? "",
      to_addr: row.to ?? row.recipient ?? "",
      subject: row.subject ?? "",
      snippet: String(row.snippet ?? row.preview ?? "").slice(0, 1000),
      body_text: String(row.messageText ?? row.body ?? "").slice(0, 20000),
      labels: labels.map(String).join(","),
      is_unread: labels.includes("UNREAD") ? 1 : 0,
      last_from_user: labels.includes("SENT") ? 1 : 0,
      internal_date: row.messageTimestamp ?? row.internalDate ?? row.date ?? "",
    });
  }
  return messages;
}

export async function fetchCalendar(env: Env, account: ComposioAccount, daysBack = 30, daysForward = 30): Promise<Array<Record<string, unknown>>> {
  const now = Date.now();
  const data = await execute(env, {
    slug: "GOOGLECALENDAR_EVENTS_LIST",
    toolkit: "googlecalendar",
    account,
    arguments: {
      timeMin: new Date(now - daysBack * 86_400_000).toISOString(),
      timeMax: new Date(now + daysForward * 86_400_000).toISOString(),
      maxResults: 250,
    },
  });

  const rows = asArray(data.items).length > 0 ? asArray(data.items) : asArray(data.events);
  const events: Array<Record<string, unknown>> = [];
  for (const value of rows) {
    const row = asRecord(value);
    const id = String(row.id ?? "");
    if (!id) continue;
    const start = asRecord(row.start);
    const end = asRecord(row.end);
    const organizer = asRecord(row.organizer);
    events.push({
      id,
      service: "google-calendar",
      title: row.summary ?? "",
      start_at: start.dateTime ?? start.date ?? null,
      end_at: end.dateTime ?? end.date ?? null,
      is_all_day: start.date ? 1 : 0,
      location: row.location ?? "",
      organizer: organizer.email ?? "",
      attendees: asArray(row.attendees)
        .map((attendee) => String(asRecord(attendee).email ?? ""))
        .filter(Boolean)
        .join(","),
      status: row.status ?? "",
      link: row.htmlLink ?? "",
    });
  }
  return events;
}

export async function fetchFathom(
  env: Env,
  account: ComposioAccount,
  days = 120,
  maxPages = 6,
): Promise<Array<Record<string, unknown>>> {
  const createdAfter = new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const meetings: Array<Record<string, unknown>> = [];
  let cursor = "";

  for (let page = 0; page < maxPages; page += 1) {
    const arguments_: Record<string, unknown> = { created_after: createdAfter, include_action_items: true };
    if (cursor) arguments_.cursor = cursor;
    const data = await execute(env, { slug: "FATHOM_LIST_MEETINGS", toolkit: "fathom", account, arguments: arguments_ });

    for (const value of asArray(data.items)) {
      const item = asRecord(value);
      const recordingId = item.recording_id;
      if (!recordingId) continue;

      const attendees: string[] = [];
      for (const invitee of asArray(item.calendar_invitees)) {
        const person = asRecord(invitee);
        const handle = person.email ?? person.name;
        if (handle) attendees.push(String(handle));
      }
      const recorder = asRecord(item.recorded_by);
      if (recorder.email) attendees.push(String(recorder.email));

      meetings.push({
        id: `fathom_${recordingId}`,
        title: String(item.title ?? item.meeting_title ?? "(untitled meeting)").slice(0, 300),
        endedAt: item.recording_end_time ?? item.created_at,
        attendees: attendees.slice(0, 12),
        summary: String(item.default_summary ?? "").slice(0, 4000),
        actionItems: asArray(item.action_items)
          .map((action) => String(asRecord(action).description ?? action))
          .slice(0, 20),
        url: item.share_url ?? item.url ?? "",
      });
    }

    cursor = String(data.next_cursor ?? "");
    if (!cursor) break;
  }
  return meetings;
}
