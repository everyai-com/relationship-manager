import type { D1Like } from "@rel/core";
import { derivePeopleFromMeetings, derivePeopleFromMessages, type IngestedMeeting, type IngestedMessage } from "./tools/people-store";

/**
 * The one way data enters the graph.
 *
 * Two producers use it — the local Python connectors and the cloud sync that
 * pulls through Composio — and both must land the same way: rows upserted,
 * people derived from what is genuinely new, the connection card and the push
 * log updated, and freshness decided from the newest row rather than from what
 * the producer claims.
 */

export interface SyncPayload {
  source: string;
  label?: string;
  status?: string;
  last_sync_at?: string;
  detail?: string;
  /** The user's own addresses — they are never people in their own graph. */
  self_addresses?: string[];
  messages?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  meetings?: Array<Record<string, unknown>>;
}

/** Calendar rows live under their own service name. */
export function serviceForEvents(source: string): string {
  return source === "calendar" ? "google-calendar" : source;
}

export async function applySync(db: D1Database, body: SyncPayload) {
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

  // Novelty has to be decided BEFORE the insert below, or every message looks
  // like one we already had — and nothing would ever be derived from it.
  const incoming = (body.messages ?? []) as Array<Record<string, unknown>>;
  const novel: Array<Record<string, unknown>> = [];
  for (let i = 0; i < incoming.length; i += 40) {
    const chunk = incoming.slice(i, i + 40);
    const knownRows = await db
      .prepare(`SELECT id FROM messages WHERE service = ? AND id IN (${chunk.map(() => "?").join(",")})`)
      .bind(body.source, ...chunk.map((message) => String(message.id)))
      .all<{ id: string }>();
    const known = new Set((knownRows.results ?? []).map((row) => row.id));
    for (const message of chunk) {
      if (!known.has(String(message.id))) novel.push(message);
    }
  }

  if (statements.length) {
    for (let i = 0; i < statements.length; i += 50) {
      const chunk = statements.slice(i, i + 50);
      await db.batch(chunk);
      inserted += chunk.length;
    }
  }

  // Ingesting mail without deriving the people it implies would leave the graph
  // counting messages whose senders do not exist. Only the new ones may move
  // counts, so re-pushing an unchanged mailbox changes nothing.
  const mail = await derivePeopleFromMessages(
    db as unknown as D1Like,
    now,
    novel as IngestedMessage[],
    body.self_addresses ?? [],
  );
  const calls = await derivePeopleFromMeetings(
    db as unknown as D1Like,
    now,
    (body.meetings ?? []) as IngestedMeeting[],
    body.self_addresses ?? [],
  );
  const derived = {
    touched: mail.touched + calls.touched,
    created: mail.created + calls.created,
    linked: mail.linked + calls.linked,
    self_skipped: mail.self,
  };

  await db
    .prepare(
      `INSERT INTO sync_log (source, pushed_at, inserted, updated, skipped, detail) VALUES (?, ?, ?, 0, 0, ?)`,
    )
    .bind(body.source, now, inserted, body.detail ?? "")
    .run();

  // The card reflects the graph, not the batch that happened to arrive last.
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE service = ? OR service = ?) AS messages,
         (SELECT COUNT(*) FROM events WHERE service = ?) AS events,
         (SELECT COUNT(*) FROM meetings WHERE id LIKE ?) AS meetings,
         (SELECT MAX(d) FROM (
            SELECT MAX(internal_date) AS d FROM messages WHERE service = ? OR service = ?
            UNION ALL SELECT MAX(start_at) FROM events WHERE service = ?
            UNION ALL SELECT MAX(ended_at) FROM meetings WHERE id LIKE ?
         )) AS newest`,
    )
    .bind(
      body.source,
      `whatsapp:${body.source}`,
      serviceForEvents(body.source),
      `${body.source}%`,
      body.source,
      `whatsapp:${body.source}`,
      serviceForEvents(body.source),
      `${body.source}%`,
    )
    .first<{ messages: number; events: number; meetings: number; newest: string | null }>();

  const total = (counts?.messages ?? 0) + (counts?.events ?? 0) + (counts?.meetings ?? 0);

  // Freshness is decided here, from the newest row in the graph — a connector
  // must not be able to claim "connected" over month-old data, and the e2e
  // suite proves it after a push.
  const claimed = (body.status as string) ?? "";
  let status = claimed;
  if (claimed !== "error" && claimed !== "not_configured") {
    const newest = counts?.newest ? Date.parse(counts.newest) : Number.NaN;
    if (Number.isNaN(newest)) {
      status = total > 0 ? "stale" : claimed || "not_configured";
    } else {
      const ageDays = (Date.now() - newest) / 86_400_000;
      status = ageDays <= 3 ? "connected" : "stale";
      if (status === "stale" && claimed !== "stale") {
        body.detail = `${body.detail ? `${body.detail} ` : ""}Newest item is ${String(counts?.newest).slice(0, 10)} (${Math.floor(ageDays)} days old).`;
      }
    }
  }

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
      status,
      body.last_sync_at ?? now,
      total,
      body.detail ?? "",
    )
    .run();

  return { inserted, status, ...derived };
}
