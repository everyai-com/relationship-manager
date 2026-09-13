import {
  identityKey,
  isRobotAddress,
  normalizeEmail,
  type D1Like,
  type IdentifierKind,
} from "@rel/core";

/**
 * Person resolution, shared by the tool handlers and the sync path so an
 * ingested message and an imported connection create rows the same way.
 */

export interface CandidateHandle {
  kind: IdentifierKind;
  value: string;
}

async function first<T>(db: D1Like, sql: string, ...args: unknown[]): Promise<T | null> {
  return ((await db.prepare(sql).bind(...args).first<T>()) ?? null) as T | null;
}

async function run(db: D1Like, sql: string, ...args: unknown[]) {
  return db.prepare(sql).bind(...args).run();
}

/** Find the person behind any of these handles, or make one. */
export async function resolveOrCreatePerson(
  db: D1Like,
  now: string,
  candidates: CandidateHandle[],
  fallback: { name?: string; email?: string } = {},
): Promise<{ personId: number; created: boolean; linked: number }> {
  let personId: number | null = null;
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const row = await first<{ person_id: number }>(
      db,
      "SELECT person_id FROM person_identifiers WHERE kind = ? AND value = ?",
      candidate.kind,
      candidate.value,
    );
    if (row) {
      personId = row.person_id;
      break;
    }
  }

  const created = personId === null;
  if (personId === null) {
    const inserted = await run(
      db,
      "INSERT INTO people (email, name, company_domain, created_at, updated_at) VALUES (?, ?, '', ?, ?)",
      fallback.email ?? "",
      fallback.name ?? "",
      now,
      now,
    );
    personId = Number((inserted.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
    if (!personId) return { personId: 0, created: false, linked: 0 };
  }

  let linked = 0;
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const result = await run(
      db,
      "INSERT OR IGNORE INTO person_identifiers (person_id, kind, value, created_at) VALUES (?, ?, ?, ?)",
      personId,
      candidate.kind,
      candidate.value,
      now,
    );
    linked += Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  }

  return { personId, created, linked };
}

export interface IngestedMeeting {
  id?: string | null;
  title?: string | null;
  endedAt?: string | null;
  attendees?: unknown;
}

/**
 * Make the people a batch of recorded meetings implies. Attendees arrive as
 * emails or as display names; an email is an identity, a name is only a handle,
 * and they land in the index accordingly.
 */
export interface IngestedMessage {
  from_addr?: string | null;
  to_addr?: string | null;
  last_from_user?: number | boolean | null;
  internal_date?: string | null;
}

export async function derivePeopleFromMeetings(
  db: D1Like,
  now: string,
  meetings: IngestedMeeting[],
  selfAddresses: string[],
): Promise<{ touched: number; created: number; linked: number }> {
  const self = new Set(selfAddresses.map((value) => normalizeEmail(value)).filter(Boolean));
  const perPerson = new Map<number, { count: number; last: string }>();
  const seen = new Set<string>();
  let created = 0;
  let linked = 0;

  for (const meeting of meetings) {
    const at = String(meeting.endedAt ?? "").slice(0, 10);
    const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : [];
    for (const raw of attendees) {
      const value = String(raw ?? "").trim();
      if (!value) continue;

      const isEmail = value.includes("@");
      const email = isEmail ? normalizeEmail(value) : "";
      if (email && (self.has(email) || isRobotAddress(email))) continue;

      const candidate = isEmail ? { kind: "email" as const, value: email } : { kind: "fathom_attendee" as const, value: value.toLowerCase() };
      const key = identityKey(candidate.kind, candidate.value);
      if (seen.has(key)) continue;
      seen.add(key);

      const resolved = await resolveOrCreatePerson(db, now, [candidate], { name: isEmail ? "" : value, email });
      if (!resolved.personId) continue;
      if (resolved.created) created += 1;
      linked += resolved.linked;

      const stats = perPerson.get(resolved.personId) ?? { count: 0, last: "" };
      stats.count += 1;
      if (at && at > stats.last) stats.last = at;
      perPerson.set(resolved.personId, stats);
    }
  }

  for (const [personId, stats] of perPerson) {
    await run(
      db,
      `UPDATE people SET meeting_count = meeting_count + ?, last_touch = MAX(COALESCE(last_touch, ''), ?), updated_at = ? WHERE id = ?`,
      stats.count,
      stats.last || now.slice(0, 10),
      now,
      personId,
    );
  }

  return { touched: perPerson.size, created, linked };
}

/**
 * Make the people a batch of messages implies. Without this, ingesting mail
 * would leave the graph saying "745 messages" while the senders stayed
 * invisible — the opposite of the point.
 */
export async function derivePeopleFromMessages(
  db: D1Like,
  now: string,
  messages: IngestedMessage[],
  selfAddresses: string[],
): Promise<{ touched: number; created: number; linked: number; self: number }> {
  const self = new Set(selfAddresses.map((value) => normalizeEmail(value)).filter(Boolean));
  const perPerson = new Map<number, { messages: number; inbound: number; last: string }>();
  const seen = new Set<string>();
  let created = 0;
  let linked = 0;
  let selfSkipped = 0;

  for (const message of messages) {
    const inbound = !message.last_from_user;
    const at = String(message.internal_date ?? "").slice(0, 10);
    for (const [raw, isSender] of [
      [message.to_addr, false],
      [message.from_addr, true],
    ] as Array<[string | null | undefined, boolean]>) {
      const parsed = String(raw ?? "").match(/<([^>\s]*@[^>\s]*)>?/);
      const address = normalizeEmail(parsed?.[1] ?? String(raw ?? ""));
      if (!address || !address.includes("@")) continue;
      if (self.has(address)) {
        selfSkipped += 1;
        continue;
      }
      if (isRobotAddress(address)) continue;

      const key = identityKey("email", address);
      if (seen.has(key)) continue;
      seen.add(key);

      // The address goes on the row as well as the index, so a person known
      // only from mail still reads as themselves in a list.
      const resolved = await resolveOrCreatePerson(db, now, [{ kind: "email", value: address }], {
        name: "",
        email: address,
      });
      if (!resolved.personId) continue;
      if (resolved.created) created += 1;
      linked += resolved.linked;

      const stats = perPerson.get(resolved.personId) ?? { messages: 0, inbound: 0, last: "" };
      stats.messages += 1;
      // A message they sent, or any mail that arrived, is a real exchange.
      if (isSender || inbound) stats.inbound += 1;
      if (at && at > stats.last) stats.last = at;
      perPerson.set(resolved.personId, stats);
    }
  }

  for (const [personId, stats] of perPerson) {
    await run(
      db,
      `UPDATE people SET message_count = message_count + ?, last_touch = MAX(COALESCE(last_touch, ''), ?), updated_at = ? WHERE id = ?`,
      stats.messages,
      stats.last || now.slice(0, 10),
      now,
      personId,
    );

    if (stats.inbound > 0) {
      // Same law as everywhere else: an observation, scored in code.
      await run(
        db,
        `INSERT INTO person_facts (person_id, field, value, band, score, evidence, rationale, status, observed_at, created_at, updated_at)
         VALUES (?, 'replied', 'yes', 'VERIFIED', 0.85, ?, ?, 'APPLIED', ?, ?, ?)
         ON CONFLICT(person_id, field, value) DO NOTHING`,
        personId,
        JSON.stringify([
          { kind: "email.thread-reply", detail: `they replied on ${stats.inbound} email ${stats.inbound === 1 ? "thread" : "threads"} we have` },
        ]),
        "They replied on an email thread we have",
        stats.last || now.slice(0, 10),
        now,
        now,
      );
    }
  }

  return { touched: perPerson.size, created, linked, self: selfSkipped };
}
