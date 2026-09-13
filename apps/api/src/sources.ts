import type { D1Like } from "@rel/core";
import {
  ComposioError,
  TOOLKITS,
  composioConfigured,
  createConnectLink,
  fetchCalendar,
  fetchFathom,
  fetchGmail,
  getAccount,
  listAccounts,
  removeAccount,
  toolkitFor,
  type ComposioAccount,
  type ToolkitSpec,
} from "./composio";
import type { Env } from "./env";
import { applySync } from "./sync";

/**
 * Sources — the accounts behind the graph, and the pulls that keep it fresh.
 *
 * Connections are Composio's; "which of these does *this* graph use" is ours, and
 * it lives in `source_accounts`. A source may have several accounts (work and
 * personal Gmail, two calendars), each independently enabled, so a sync reads
 * exactly what the human ticked and nothing else.
 */

/** New connections belong to this deployment, not to whatever user id created the old ones. */
const COMPOSIO_USER_ID = "relationship-manager";

const DEFAULT_GMAIL_QUERY = "newer_than:7d";
const FIRST_GMAIL_QUERY = "newer_than:30d";

export interface SourceAccount {
  id: number;
  connection_id: string;
  label: string;
  status: string;
  enabled: boolean;
  is_default: boolean;
  live: boolean;
  synced_at: string | null;
}

export interface SourceToolkitPayload extends ToolkitSpec {
  accounts: SourceAccount[];
  last_sync_at: string | null;
}

export interface SourcesPayload {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  toolkits: SourceToolkitPayload[];
}

interface AccountRow {
  id: number;
  toolkit: string;
  connection_id: string;
  label: string;
  status: string;
  enabled: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

async function rows(db: D1Like, sql: string, ...args: unknown[]): Promise<AccountRow[]> {
  const result = await db.prepare(sql).bind(...args).all<AccountRow>();
  return (result.results ?? []) as AccountRow[];
}

async function lastSyncs(db: D1Like): Promise<Map<string, string>> {
  const result = await db
    .prepare("SELECT source, MAX(pushed_at) AS pushed_at FROM sync_log GROUP BY source")
    .all<{ source: string; pushed_at: string }>();
  return new Map((result.results ?? []).map((row) => [row.source, row.pushed_at]));
}

function active(account: ComposioAccount): boolean {
  return account.status === "ACTIVE" || account.status === "CONNECTED";
}

function shape(row: AccountRow, live: Map<string, ComposioAccount>): SourceAccount {
  const remote = live.get(row.connection_id);
  return {
    id: row.id,
    connection_id: row.connection_id,
    label: row.label || remote?.label || remote?.alias || row.connection_id,
    // The live status wins when Composio is reachable; the stored one is what we
    // last knew, which is all we can honestly show when it is not.
    status: remote ? (active(remote) ? "connected" : remote.status.toLowerCase()) : row.status,
    enabled: row.enabled === 1,
    is_default: row.is_default === 1,
    live: Boolean(remote),
    synced_at: row.updated_at,
  };
}

/**
 * Accounts that exist in Composio but not yet here (made in the dashboard, or by
 * an earlier tool) are adopted — the first ACTIVE one per toolkit is enabled so
 * the feature works on arrival, the rest wait for a deliberate tick.
 */
async function adopt(db: D1Like, live: ComposioAccount[]): Promise<void> {
  const wanted = new Map(TOOLKITS.map((toolkit) => [toolkit.slug, toolkit]));
  const now = new Date().toISOString();

  for (const account of live) {
    const toolkit = wanted.get(account.toolkit);
    if (!toolkit) continue;
    const known = await rows(db, "SELECT id FROM source_accounts WHERE connection_id = ?", account.id);
    if (known.length > 0) continue;

    // The first *working* account per toolkit is switched on so the feature works
    // on arrival; everything after it waits for a deliberate tick — otherwise a
    // dashboard with a dozen abandoned connects would sync all dozen.
    const enabled = await rows(db, "SELECT id FROM source_accounts WHERE toolkit = ? AND enabled = 1", toolkit.slug);
    const first = enabled.length === 0 && active(account);
    await db
      .prepare(
        `INSERT INTO source_accounts (toolkit, connection_id, label, status, enabled, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id) DO NOTHING`,
      )
      .bind(
        toolkit.slug,
        account.id,
        account.label || account.alias || account.id,
        active(account) ? "connected" : "pending",
        first ? 1 : 0,
        first ? 1 : 0,
        now,
        now,
      )
      .run();
  }
}

export async function sourcesPayload(env: Env, db: D1Like): Promise<SourcesPayload> {
  const configured = composioConfigured(env);
  let live: ComposioAccount[] = [];
  let error: string | null = null;

  if (configured) {
    try {
      live = await listAccounts(env);
      await adopt(db, live);
    } catch (issue) {
      error = issue instanceof Error ? issue.message : String(issue);
    }
  } else {
    error = "COMPOSIO_API_KEY is not set on this deployment — accounts can be listed but not connected.";
  }

  const liveById = new Map(live.map((account) => [account.id, account]));
  const stored = await rows(db, "SELECT * FROM source_accounts ORDER BY is_default DESC, id");
  const syncs = await lastSyncs(db);

  return {
    configured,
    reachable: configured && error === null,
    error,
    toolkits: TOOLKITS.map((toolkit) => ({
      ...toolkit,
      // Working accounts first; an abandoned connect is still listed, just last.
      accounts: stored
        .filter((row) => row.toolkit === toolkit.slug)
        .sort((a, b) => {
          const rank = (row: AccountRow) => (shape(row, liveById).status === "connected" ? 0 : 1);
          return rank(a) - rank(b) || b.is_default - a.is_default || a.id - b.id;
        })
        .map((row) => shape(row, liveById)),
      last_sync_at: syncs.get(toolkit.source) ?? null,
    })),
  };
}

export async function sourceConnect(
  env: Env,
  db: D1Like,
  toolkitSlug: string,
  origin: string,
): Promise<{ redirect_url: string | null; connection_id: string; account: SourceAccount }> {
  const toolkit = toolkitFor(toolkitSlug);
  if (!toolkit) throw new ComposioError(`Unknown source "${toolkitSlug}"`, 400);
  if (!composioConfigured(env)) throw new ComposioError("COMPOSIO_API_KEY is not set on this deployment", 503);

  const { connectionId, redirectUrl, active: isActive } = await createConnectLink(
    env,
    db,
    toolkit.slug,
    COMPOSIO_USER_ID,
    `${origin.replace(/\/+$/, "")}/`,
  );

  const now = new Date().toISOString();
  const existing = await rows(db, "SELECT id FROM source_accounts WHERE toolkit = ?", toolkit.slug);
  const first = existing.length === 0 && isActive;
  await db
    .prepare(
      `INSERT INTO source_accounts (toolkit, connection_id, label, status, enabled, is_default, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
    .bind(toolkit.slug, connectionId, isActive ? "connected" : "pending", first ? 1 : 0, first ? 1 : 0, now, now)
    .run();

  const row = (await rows(db, "SELECT * FROM source_accounts WHERE connection_id = ?", connectionId))[0];
  if (!row) throw new ComposioError("the sign-in could not be recorded", 500);

  return { redirect_url: redirectUrl, connection_id: connectionId, account: shape(row, new Map()) };
}

/** Polled by the UI while the human finishes signing in in the other tab. */
export async function sourceAccount(env: Env, db: D1Like, id: number): Promise<SourceAccount> {
  const row = (await rows(db, "SELECT * FROM source_accounts WHERE id = ?", id))[0];
  if (!row) throw new ComposioError("account not found", 404);

  let liveAccount: ComposioAccount | null = null;
  try {
    liveAccount = await getAccount(env, row.connection_id);
  } catch (issue) {
    if (issue instanceof ComposioError && issue.status === 404) {
      await db.prepare("DELETE FROM source_accounts WHERE id = ?").bind(id).run();
      throw new ComposioError("that connection no longer exists in Composio", 404);
    }
    throw issue;
  }

  if (liveAccount) {
    const label = liveAccount.label || liveAccount.alias || row.label;
    const status = active(liveAccount) ? "connected" : liveAccount.status.toLowerCase();
    if (label !== row.label || status !== row.status) {
      await db
        .prepare("UPDATE source_accounts SET label = ?, status = ?, updated_at = ? WHERE id = ?")
        .bind(label, status, new Date().toISOString(), id)
        .run();
      row.label = label;
      row.status = status;
    }
  }

  return shape(row, liveAccount ? new Map([[liveAccount.id, liveAccount]]) : new Map());
}

export async function sourceUpdate(
  env: Env,
  db: D1Like,
  id: number,
  patch: { enabled?: boolean; is_default?: boolean },
): Promise<SourceAccount> {
  const row = (await rows(db, "SELECT * FROM source_accounts WHERE id = ?", id))[0];
  if (!row) throw new ComposioError("account not found", 404);

  const now = new Date().toISOString();
  if (patch.enabled !== undefined) {
    await db.prepare("UPDATE source_accounts SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(patch.enabled ? 1 : 0, now, id)
      .run();
  }
  if (patch.is_default) {
    // Exactly one default per toolkit, or "default" means nothing.
    await db.prepare("UPDATE source_accounts SET is_default = 0, updated_at = ? WHERE toolkit = ?").bind(now, row.toolkit).run();
    await db.prepare("UPDATE source_accounts SET is_default = 1, enabled = 1, updated_at = ? WHERE id = ?").bind(now, id).run();
  }

  return sourceAccount(env, db, id);
}

export async function sourceDisconnect(env: Env, db: D1Like, id: number): Promise<void> {
  const row = (await rows(db, "SELECT * FROM source_accounts WHERE id = ?", id))[0];
  if (!row) throw new ComposioError("account not found", 404);
  try {
    await removeAccount(env, row.connection_id);
  } catch (issue) {
    // Removing it here is what the human asked for; a Composio hiccup must not
    // leave the row behind pretending the account is still wired up.
    if (!(issue instanceof ComposioError)) throw issue;
  }
  await db.prepare("DELETE FROM source_accounts WHERE id = ?").bind(id).run();
}

/* ---- the pull ---- */

export interface SyncResult {
  toolkit: string;
  account: string;
  source: string;
  inserted: number;
  status: string;
  touched: number;
  created: number;
}

async function pull(
  env: Env,
  toolkit: ToolkitSpec,
  account: ComposioAccount,
  firstSync: boolean,
): Promise<Record<string, unknown>> {
  if (toolkit.slug === "gmail") {
    const messages = await fetchGmail(env, account, firstSync ? FIRST_GMAIL_QUERY : DEFAULT_GMAIL_QUERY);
    return { messages };
  }
  if (toolkit.slug === "googlecalendar") {
    const events = await fetchCalendar(env, account);
    return { events };
  }
  const meetings = await fetchFathom(env, account);
  return { meetings };
}

/**
 * Pull every enabled account of a toolkit (or all of them) and push through the
 * one ingestion path. Each account is its own sync, so the push log says which
 * mailbox a row came from.
 */
export async function sourceSync(
  env: Env,
  db: D1Like,
  toolkitSlug?: string,
): Promise<{ results: SyncResult[]; errors: Array<{ toolkit: string; account: string; error: string }> }> {
  if (!composioConfigured(env)) throw new ComposioError("COMPOSIO_API_KEY is not set on this deployment", 503);

  const wanted = toolkitSlug ? toolkitFor(toolkitSlug) : null;
  if (toolkitSlug && !wanted) throw new ComposioError(`Unknown source "${toolkitSlug}"`, 400);

  const targets = awaited(TOOLKITS, wanted);
  const live = await listAccounts(env);
  const liveById = new Map(live.map((account) => [account.id, account]));
  await adopt(db, live);

  const stored = await rows(db, "SELECT * FROM source_accounts WHERE enabled = 1 ORDER BY is_default DESC, id");

  const results: SyncResult[] = [];
  const errors: Array<{ toolkit: string; account: string; error: string }> = [];

  for (const toolkit of targets) {
    const accounts = stored.filter((row) => row.toolkit === toolkit.slug);
    if (accounts.length === 0) {
      errors.push({
        toolkit: toolkit.label,
        account: "—",
        error: `No account is connected for ${toolkit.label} yet. Connect one, then sync.`,
      });
      continue;
    }

    for (const row of accounts) {
      const account = liveById.get(row.connection_id);
      if (!account) {
        errors.push({ toolkit: toolkit.label, account: row.label, error: "This account is no longer connected in Composio." });
        continue;
      }
      if (!active(account)) {
        errors.push({ toolkit: toolkit.label, account: row.label || account.id, error: `Composio reports this account as ${account.status}.` });
        continue;
      }

      const priorSync = await db
        .prepare("SELECT id FROM sync_log WHERE source = ? AND detail LIKE ? LIMIT 1")
        .bind(toolkit.source, `%${row.connection_id}%`)
        .first<{ id: number }>();

      try {
        const pulled = await pull(env, toolkit, account, !priorSync);
        const counts = await applySync(env.DB, {
          source: toolkit.source,
          label: toolkit.label,
          detail: `Pulled live through Composio · ${row.label || account.id} (${row.connection_id}).`,
          self_addresses: row.label.includes("@") ? [row.label] : [],
          ...pulled,
        });
        results.push({
          toolkit: toolkit.label,
          account: row.label || account.id,
          source: toolkit.source,
          inserted: counts.inserted,
          status: counts.status,
          touched: counts.touched,
          created: counts.created,
        });
      } catch (issue) {
        errors.push({
          toolkit: toolkit.label,
          account: row.label || account.id,
          error: issue instanceof Error ? issue.message : String(issue),
        });
      }
    }
  }

  return { results, errors };
}

function awaited(all: ToolkitSpec[], wanted: ToolkitSpec | null): ToolkitSpec[] {
  return wanted ? all.filter((toolkit) => toolkit.slug === wanted.slug) : all;
}
