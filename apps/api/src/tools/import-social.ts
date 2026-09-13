import {
  identityKey,
  normalizeEmail,
  normalizeInstagram,
  normalizeLinkedIn,
  normalizePhone,
  ROW_FIELDS,
  scoreEvidence,
  type D1Like,
  type IdentifierKind,
  type ToolContext,
} from "@rel/core";

/**
 * Official social exports → the graph.
 *
 * Written to be *batched end to end*. The first version issued ~12 D1 round
 * trips per person and hung the Worker on a 200-row batch; a version after that
 * still cost one insert round trip per new person (~18s for 50 people). Here
 * everything is prefetch-then-write, and person creation goes through a single
 * `INSERT … RETURNING id` batch, so a batch costs a handful of round trips no
 * matter how many people are in it.
 */

const WRITE_BATCH = 50;
const LOOKUP_CHUNK = 40;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function all<T>(db: D1Like, sql: string, ...args: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...args).all<T>();
  return (res.results ?? []) as T[];
}

function normalise(kind: IdentifierKind, value: string): string {
  switch (kind) {
    case "email":
      return normalizeEmail(value);
    case "phone":
      return normalizePhone(value);
    case "linkedin":
      return normalizeLinkedIn(value);
    case "instagram":
      return normalizeInstagram(value);
    default:
      return String(value ?? "").trim();
  }
}

interface Entry {
  handles: Array<{ kind: IdentifierKind; value: string }>;
  name: string;
  email: string;
  company: string;
  title: string;
  connectedOn: string | null;
  evidenceKind: string;
  note: string;
}

interface MessageRow {
  conversationId: string;
  fromKey: string;
  toKey: string;
  fromIsSelf: boolean;
  counterpart: string;
  at: string;
  text: string;
}

export async function importSocialExport(ctx: ToolContext, args: Record<string, unknown>) {
  const db = ctx.db;
  const now = ctx.now;
  const source = String(args.source) === "instagram" ? "instagram" : "linkedin";
  const handleKind: IdentifierKind = source === "linkedin" ? "linkedin" : "instagram";
  const label = String(args.label ?? (source === "linkedin" ? "LinkedIn" : "Instagram"));
  const exportedAt = args.exported_at ? String(args.exported_at).slice(0, 10) : null;

  const selfHandles = new Set(
    (Array.isArray(args.self_handles) ? (args.self_handles as string[]) : [])
      .map((value) => normalise(handleKind, value))
      .filter(Boolean),
  );

  const rawPeople = Array.isArray(args.people) ? (args.people as Array<Record<string, unknown>>) : [];
  const rawMessages = Array.isArray(args.messages) ? (args.messages as Array<Record<string, unknown>>) : [];

  // ---- 1. normalise input -------------------------------------------------
  const entries: Entry[] = [];
  for (const row of rawPeople) {
    const handles: Entry["handles"] = [];
    const email = normalise("email", String(row.email ?? ""));
    if (email) handles.push({ kind: "email", value: email });
    const linkedin = normalise("linkedin", String(row.linkedin ?? ""));
    if (linkedin) handles.push({ kind: "linkedin", value: linkedin });
    const instagram = normalise("instagram", String(row.instagram ?? ""));
    if (instagram) handles.push({ kind: "instagram", value: instagram });
    const phone = normalise("phone", String(row.phone ?? ""));
    if (phone) handles.push({ kind: "phone", value: phone });

    const name = String(row.name ?? "").trim();
    if (handles.length === 0 && !name) continue;

    entries.push({
      handles,
      name,
      email,
      company: String(row.company ?? "").trim(),
      title: String(row.title ?? "").trim(),
      connectedOn: row.connected_on ? String(row.connected_on).slice(0, 10) : null,
      evidenceKind: String(row.evidence_kind ?? (source === "linkedin" ? "linkedin.connection" : "instagram.you-follow")),
      note: String(row.note ?? "").slice(0, 300),
    });
  }

  const messages: MessageRow[] = [];
  for (const row of rawMessages) {
    const at = String(row.at ?? "");
    const text = String(row.text ?? "");
    if (!at || !text) continue;
    const fromKey = normalise(handleKind, String(row.from_handle ?? ""));
    const toKey = normalise(handleKind, String(row.to_handle ?? ""));
    const fromIsSelf = fromKey ? selfHandles.has(fromKey) : false;
    const toIsSelf = toKey ? selfHandles.has(toKey) : false;
    const counterpart = fromKey && !fromIsSelf ? fromKey : toKey && !toIsSelf ? toKey : "";
    messages.push({ conversationId: String(row.conversation_id ?? ""), fromKey, toKey, fromIsSelf, counterpart, at, text });
  }

  // ---- 2. one prefetch resolves every handle in the batch -----------------
  const wanted = new Map<string, { kind: IdentifierKind; value: string }>();
  for (const entry of entries) for (const handle of entry.handles) wanted.set(identityKey(handle.kind, handle.value), handle);
  for (const message of messages) {
    if (message.counterpart) wanted.set(identityKey(handleKind, message.counterpart), { kind: handleKind, value: message.counterpart });
  }

  const resolved = new Map<string, number>();
  for (const batch of chunks([...wanted.values()], LOOKUP_CHUNK)) {
    const clause = batch.map(() => "(kind = ? AND value = ?)").join(" OR ");
    const rows = await all<{ person_id: number; kind: string; value: string }>(
      db,
      `SELECT person_id, kind, value FROM person_identifiers WHERE ${clause}`,
      ...batch.flatMap((handle) => [handle.kind, handle.value]),
    );
    for (const row of rows) resolved.set(identityKey(row.kind as IdentifierKind, row.value), row.person_id);
  }

  const counts = { people_created: 0, people_merged: 0, identifiers: 0, suggestions: 0, applied: 0, messages: 0 };
  const statements: Array<ReturnType<D1Like["prepare"]>> = [];
  const queue = (sql: string, ...values: unknown[]) => statements.push(db.prepare(sql).bind(...values));

  /** Create people in batches — one `INSERT … RETURNING id` per row, one round trip per batch. */
  const createPeople = async (rows: Array<{ handles: Entry["handles"]; name: string; email: string }>): Promise<number[]> => {
    const ids: number[] = [];
    for (const batch of chunks(rows, WRITE_BATCH)) {
      const results = await db.batch(
        batch.map((row) =>
          db
            .prepare("INSERT INTO people (email, name, company_domain, created_at, updated_at) VALUES (?, ?, '', ?, ?) RETURNING id")
            .bind(row.email, row.name, now, now),
        ),
      );
      results.forEach((result) => {
        const id = Number((result.results?.[0] as { id?: number } | undefined)?.id ?? 0);
        ids.push(id);
      });
    }
    return ids;
  };

  // ---- 3. resolve people (create the new ones in one pass) ----------------
  const assigned = new Map<number, Entry>();
  const links: Array<{ personId: number; handle: { kind: IdentifierKind; value: string } }> = [];
  const toCreate: Array<{ entry: Entry }> = [];

  const link = (personId: number, entry: Entry) => {
    for (const handle of entry.handles) {
      resolved.set(identityKey(handle.kind, handle.value), personId);
      links.push({ personId, handle });
    }
  };

  for (const entry of entries) {
    let personId: number | undefined;
    for (const handle of entry.handles) {
      const found = resolved.get(identityKey(handle.kind, handle.value));
      if (found) {
        personId = found;
        break;
      }
    }
    if (personId === undefined) {
      toCreate.push({ entry });
      continue;
    }
    if (assigned.has(personId)) counts.people_merged += 1;
    assigned.set(personId, entry);
    link(personId, entry);
  }

  const createdIds = await createPeople(toCreate.map(({ entry }) => ({ handles: entry.handles, name: entry.name, email: entry.email })));
  createdIds.forEach((personId, index) => {
    const entry = toCreate[index]!.entry;
    if (!personId) return;
    counts.people_created += 1;
    assigned.set(personId, entry);
    link(personId, entry);
  });

  for (const { personId, handle } of links) {
    queue(
      "INSERT OR IGNORE INTO person_identifiers (person_id, kind, value, created_at) VALUES (?, ?, ?, ?)",
      personId,
      handle.kind,
      handle.value,
      now,
    );
  }

  // ---- 4. what the export says about them (through the ledger) ------------
  const personIds = [...assigned.keys()];
  const existingFacts = new Map<string, string>();
  for (const batch of chunks(personIds, LOOKUP_CHUNK)) {
    const rows = await all<{ person_id: number; field: string; value: string; status: string }>(
      db,
      `SELECT person_id, field, value, status FROM person_facts WHERE field IN ('company', 'title') AND person_id IN (${batch
        .map(() => "?")
        .join(",")})`,
      ...batch,
    );
    for (const row of rows) existingFacts.set(`${row.person_id}|${row.field}|${row.value}`, row.status);
  }

  for (const [personId, entry] of assigned) {
    if (entry.name) queue("UPDATE people SET name = ?, updated_at = ? WHERE id = ? AND name = ''", entry.name, now, personId);
    if (entry.connectedOn) {
      queue(
        "UPDATE people SET last_touch = MAX(COALESCE(last_touch, ''), ?), updated_at = ? WHERE id = ?",
        entry.connectedOn,
        now,
        personId,
      );
    }

    const detail = [label, entry.connectedOn, entry.note].filter(Boolean).join(" · ");
    const evidence = [{ kind: entry.evidenceKind, detail: detail || label }];
    const scored = scoreEvidence(evidence);
    if (!scored.band) continue;

    for (const [field, value] of [
      ["company", entry.company],
      ["title", entry.title],
    ] as Array<[string, string]>) {
      if (!value) continue;
      const key = `${personId}|${field}|${value}`;
      const status = existingFacts.get(key);
      if (status === "DISMISSED" || status === "APPLIED") continue;

      const applies = scored.band === "VERIFIED";
      queue(
        `INSERT INTO person_facts (person_id, field, value, band, score, evidence, rationale, status, source_url, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(person_id, field, value) DO UPDATE SET band = excluded.band, score = excluded.score,
           evidence = excluded.evidence, rationale = excluded.rationale, status = excluded.status, updated_at = excluded.updated_at`,
        personId,
        field,
        value,
        scored.band,
        scored.score,
        JSON.stringify(evidence),
        scored.rationale,
        applies ? "APPLIED" : "PROPOSED",
        exportedAt ?? now,
        now,
        now,
      );

      if (applies && ROW_FIELDS.has(field)) {
        queue(`UPDATE people SET ${field} = ?, updated_at = ? WHERE id = ? AND (${field} = '' OR ${field} IS NULL)`, value, now, personId);
        counts.applied += 1;
      } else {
        counts.suggestions += 1;
      }
      existingFacts.set(key, applies ? "APPLIED" : "PROPOSED");
    }
  }

  // ---- 5. message counterparts we have never seen ------------------------
  const unknownCounterparts = new Map<string, string>();
  for (const message of messages) {
    if (!message.counterpart) continue;
    const key = identityKey(handleKind, message.counterpart);
    if (resolved.has(key) || unknownCounterparts.has(key)) continue;
    unknownCounterparts.set(key, message.counterpart);
  }
  const counterpartIds = await createPeople([...unknownCounterparts.values()].map((value) => ({ handles: [], name: "", email: "" })));
  counterpartIds.forEach((personId, index) => {
    if (!personId) return;
    const handle = [...unknownCounterparts.values()][index]!;
    counts.people_created += 1;
    resolved.set(identityKey(handleKind, handle), personId);
    queue("INSERT OR IGNORE INTO person_identifiers (person_id, kind, value, created_at) VALUES (?, ?, ?, ?)", personId, handleKind, handle, now);
  });

  // ---- 6. messages --------------------------------------------------------
  const messageCounts = new Map<number, { count: number; last: string }>();
  for (const message of messages) {
    const id = `${source}:${message.conversationId || "thread"}:${message.at}:${(message.fromKey || message.toKey).slice(-24)}`;
    queue(
      `INSERT OR IGNORE INTO messages (id, service, thread_id, from_addr, to_addr, subject, snippet, body_text, labels, is_unread, last_from_user, internal_date, synced_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, '', 0, ?, ?, ?)`,
      id,
      source,
      message.conversationId,
      message.fromKey,
      message.toKey,
      message.text.slice(0, 400),
      message.text,
      message.fromIsSelf ? 1 : 0,
      message.at,
      now,
    );

    const personId = message.counterpart ? resolved.get(identityKey(handleKind, message.counterpart)) : undefined;
    if (personId) {
      const current = messageCounts.get(personId) ?? { count: 0, last: "" };
      current.count += 1;
      if (message.at > current.last) current.last = message.at;
      messageCounts.set(personId, current);
    }
  }

  for (const [personId, stats] of messageCounts) {
    queue(
      "UPDATE people SET message_count = message_count + ?, last_touch = MAX(COALESCE(last_touch, ''), ?), updated_at = ? WHERE id = ?",
      stats.count,
      stats.last.slice(0, 10),
      now,
      personId,
    );
  }

  // ---- 7. flush -----------------------------------------------------------
  for (const batch of chunks(statements, WRITE_BATCH)) {
    await db.batch(batch);
  }
  counts.identifiers = links.length;
  counts.messages = messages.length;

  // The card reflects the graph, not what this call happened to carry.
  const handleCount =
    (await all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM person_identifiers WHERE kind = ?", handleKind))[0]?.n ?? 0;
  const messageCount = (await all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages WHERE service = ?", source))[0]?.n ?? 0;

  await db
    .prepare(
      `INSERT INTO connections (id, source, label, status, last_sync_at, item_count, detail)
       VALUES (?, ?, ?, 'stale', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at, item_count = excluded.item_count, detail = excluded.detail`,
    )
    .bind(
      source,
      source,
      label,
      exportedAt,
      handleCount + messageCount,
      `Imported from the official ${label} export${exportedAt ? ` (${exportedAt})` : ""}: ${handleCount} handles, ` +
        `${messageCount} messages. No live sync is possible — ${label} has no API for a personal account's own ` +
        `connections, so refreshing means exporting again.`,
    )
    .run();

  return counts;
}
