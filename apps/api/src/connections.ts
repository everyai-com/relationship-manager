import type { D1Like } from "@rel/core";
import { all, first } from "./tools/handlers";

/**
 * Connections — one honest payload for the screen.
 *
 * The `connections` row says what a source claimed at push time; this module adds
 * what is actually in the graph (counts, newest row, age) and how to refresh it.
 * Freshness is measured from the data, never from the push — a connector cannot
 * claim to be live over old rows.
 */

export interface RefreshInstruction {
  kind: "command" | "export" | "none";
  command?: string;
  note: string;
}

export interface SourceGraph {
  messages: number;
  events: number;
  meetings: number;
  records: number;
}

export interface ConnectionSource {
  id: string;
  source: string;
  label: string;
  status: string;
  last_sync_at: string | null;
  item_count: number;
  detail: string;
  graph: SourceGraph;
  newest_item_at: string | null;
  freshness_days: number | null;
  refresh: RefreshInstruction;
}

export interface SyncEntry {
  source: string;
  pushed_at: string;
  inserted: number;
  updated: number;
  skipped: number;
  detail: string;
}

export interface ConnectionsPayload {
  summary: {
    sources: number;
    connected: number;
    stale: number;
    error: number;
    not_configured: number;
    items: number;
    freshness_rule: string;
  };
  sources: ConnectionSource[];
  syncs: SyncEntry[];
}

const REFRESH: Record<string, RefreshInstruction> = {
  gmail: {
    kind: "command",
    command: "cd connectors && python3 -m rel_sync.cli aios",
    note: "Reads the AIOS workspace on this machine — mail, calendar and WhatsApp in one pass.",
  },
  whatsapp: {
    kind: "command",
    command: "cd connectors && python3 -m rel_sync.cli aios",
    note: "Reads the AIOS workspace on this machine — mail, calendar and WhatsApp in one pass.",
  },
  "google-calendar": {
    kind: "command",
    command: "cd connectors && python3 -m rel_sync.cli aios",
    note: "Reads the AIOS workspace on this machine — mail, calendar and WhatsApp in one pass.",
  },
  fathom: {
    kind: "command",
    command: "cd connectors && python3 -m rel_sync.cli composio --what fathom",
    note: "Pulls recorded meetings live through Composio.",
  },
  linkedin: {
    kind: "export",
    command: "npm run rel -- import-linkedin <export-folder>",
    note: "LinkedIn has no API for your own connections — refreshing means exporting again, and this stays honest about its date.",
  },
  instagram: {
    kind: "export",
    command: "npm run rel -- import-instagram <export.zip>",
    note: "Instagram's API is business-only — refreshing means exporting again from Accounts Center.",
  },
  "revenue-desk": {
    kind: "none",
    note: "Imported once from the CRM export. There is no live source to refresh.",
  },
  slack: { kind: "none", note: "Not configured on this deployment." },
  stripe: { kind: "none", note: "Not configured on this deployment." },
  ai: { kind: "none", note: "The model binding itself — nothing to sync; it runs on every ask." },
};

const DEFAULT_REFRESH: RefreshInstruction = {
  kind: "none",
  note: "No refresh path is wired for this source yet.",
};

interface CountRow {
  n: number;
  newest: string | null;
}

function daysSince(now: string, stamp: string | null): number | null {
  if (!stamp) return null;
  const then = Date.parse(stamp);
  const at = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((at - then) / 86_400_000));
}

export async function connectionsPayload(db: D1Like, now: string): Promise<ConnectionsPayload> {
  const [rows, messageCounts, eventCounts, meetings, reconnect, syncs] = await Promise.all([
    all<Omit<ConnectionSource, "graph" | "newest_item_at" | "freshness_days" | "refresh">>(
      db,
      "SELECT id, source, label, status, last_sync_at, item_count, detail FROM connections ORDER BY source",
    ),
    all<CountRow & { service: string }>(
      db,
      "SELECT service, COUNT(*) AS n, MAX(internal_date) AS newest FROM messages GROUP BY service",
    ),
    all<CountRow & { service: string }>(
      db,
      "SELECT service, COUNT(*) AS n, MAX(start_at) AS newest FROM events GROUP BY service",
    ),
    first<CountRow>(db, "SELECT COUNT(*) AS n, MAX(ended_at) AS newest FROM meetings"),
    first<CountRow>(db, "SELECT COUNT(*) AS n, MAX(conversation_last) AS newest FROM reconnect"),
    all<SyncEntry>(db, "SELECT source, pushed_at, inserted, updated, skipped, detail FROM sync_log ORDER BY id DESC LIMIT 25"),
  ]);

  const messagesByService = new Map(messageCounts.map((row) => [row.service, row]));
  const eventsByService = new Map(eventCounts.map((row) => [row.service, row]));

  const sources: ConnectionSource[] = rows.map((row) => {
    let graph: SourceGraph = { messages: 0, events: 0, meetings: 0, records: 0 };
    let newest: string | null = null;

    if (row.source === "fathom") {
      graph = { messages: 0, events: 0, meetings: meetings?.n ?? 0, records: 0 };
      newest = meetings?.newest ?? null;
    } else if (row.source === "revenue-desk") {
      graph = { messages: 0, events: 0, meetings: 0, records: reconnect?.n ?? 0 };
      newest = reconnect?.newest ?? null;
    } else if (row.source === "google-calendar") {
      const found = eventsByService.get("google-calendar");
      graph = { messages: 0, events: found?.n ?? 0, meetings: 0, records: 0 };
      newest = found?.newest ?? null;
    } else if (row.source !== "slack" && row.source !== "stripe" && row.source !== "ai") {
      const found = messagesByService.get(row.source);
      graph = { messages: found?.n ?? 0, events: 0, meetings: 0, records: 0 };
      newest = found?.newest ?? null;
    }

    return {
      ...row,
      graph,
      newest_item_at: newest,
      freshness_days: daysSince(now, newest),
      refresh: REFRESH[row.source] ?? DEFAULT_REFRESH,
    };
  });

  // The model binding is real but has no row of its own — show it as a source.
  sources.unshift({
    id: "ai",
    source: "ai",
    label: "Workers AI",
    status: "connected",
    last_sync_at: now,
    item_count: 0,
    detail: "Grounded answers (Ask, prep briefs, daily brief) run on this binding. It reads the graph live — there is nothing to sync.",
    graph: { messages: 0, events: 0, meetings: 0, records: 0 },
    newest_item_at: null,
    freshness_days: 0,
    refresh: REFRESH.ai!,
  });

  const count = (status: string) => sources.filter((row) => row.status === status).length;
  // The header total is what the cards add up to — the rows, not the claims.
  const items = sources.reduce(
    (total, row) => total + row.graph.messages + row.graph.events + row.graph.meetings + row.graph.records,
    0,
  );

  return {
    summary: {
      sources: sources.length,
      connected: count("connected"),
      stale: count("stale"),
      error: count("error"),
      not_configured: count("not_configured"),
      items,
      freshness_rule: "Freshness is measured from the newest row in the graph, never from the push. A source within 3 days reads connected; anything older reads stale, with its real date.",
    },
    sources,
    syncs,
  };
}
