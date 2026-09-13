/**
 * Seed builder — turns the real relationship corpora into one SQL file set.
 *
 * Sources (all under reference/, read-only):
 *   relationship-data/portfolio-audit/*.json   — the email/WhatsApp/Fathom audits
 *   relationship-data/live/settings.db         — extracted to data/live.json
 *   revenue-desk/directory-preview.json        — the CRM directory + reconnect cohorts
 *
 * Output: out/seed-01.sql, out/seed-02.sql … (chunked so `wrangler d1 execute`
 * stays inside its request limits), plus out/stats.json.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  companyDomainOf,
  decodeJid,
  identityKey,
  isRobotAddress,
  normalizeEmail,
  normalizePhone,
  parseAddress,
  scoreEvidence,
  type IdentifierKind,
} from "@rel/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const REF = join(ROOT, "reference");
const AUDIT = join(REF, "relationship-data", "portfolio-audit");
const LIVE = join(REF, "relationship-data", "live");
const OUT = join(HERE, "..", "out");

/**
 * The user's own addresses — never people in their own graph. Kept out of the
 * repo: put them in `packages/seed/self-addresses.json` (gitignored) as
 * `["you@example.com", ...]`, or set REL_SELF_ADDRESSES as a comma-separated list.
 */
function loadSelfAddresses(): Set<string> {
  const fromEnv = process.env.REL_SELF_ADDRESSES;
  if (fromEnv) {
    return new Set(fromEnv.split(",").map((value) => normalizeEmail(value)).filter(Boolean));
  }
  const localPath = join(HERE, "..", "self-addresses.json");
  if (existsSync(localPath)) {
    try {
      const parsed = JSON.parse(readFileSync(localPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((value) => normalizeEmail(String(value))).filter(Boolean));
      }
    } catch {
      console.warn(`  ! could not read ${localPath} — treating every address as a contact`);
    }
  }
  return new Set();
}

const SELF = loadSelfAddresses();

const COHORT_RANK: Record<string, number> = {
  "Active conversation": 5,
  "Researched opportunity": 10,
  "Past conversation — review to reconnect": 30,
  "Already contacted — await reply": 40,
  "Existing partner — coordinate": 45,
  "One-way outreach — review": 60,
  "Incoming only — review": 65,
  "Won / existing relationship": 70,
  "Meeting invite only": 75,
  "Saved contact — no exchange verified": 80,
  "Resolve relationship first": 90,
  "Personal / service / non-sales": 95,
  "Closed / no outreach": 95,
  Excluded: 99,
};

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    console.warn(`  ! missing ${path}`);
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface DraftPerson {
  id: number;
  email: string;
  name: string;
  title: string;
  company: string;
  company_domain: string;
  location: string;
  human_fields: string[];
  first_seen: string | null;
  last_touch: string | null;
  message_count: number;
  meeting_count: number;
  identifiers: Map<string, { kind: IdentifierKind; value: string }>;
}

interface DraftFact {
  person_id: number;
  field: string;
  value: string;
  band: string;
  score: number;
  evidence: Array<{ kind: string; detail?: string }>;
  rationale: string;
  status: "APPLIED" | "PROPOSED";
  source_url: string | null;
  observed_at: string;
}

const people: DraftPerson[] = [];
const byIdentifier = new Map<string, number>();
const facts: DraftFact[] = [];

function createPerson(email = ""): DraftPerson {
  const person: DraftPerson = {
    id: people.length + 1,
    email: normalizeEmail(email),
    name: "",
    title: "",
    company: "",
    company_domain: email ? companyDomainOf(email) : "",
    location: "",
    human_fields: [],
    first_seen: null,
    last_touch: null,
    message_count: 0,
    meeting_count: 0,
    identifiers: new Map(),
  };
  people.push(person);
  return person;
}

function touch(person: DraftPerson, iso: string | null | undefined, kind: "first" | "last") {
  if (!iso) return;
  const value = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  if (kind === "first") {
    if (!person.first_seen || value < person.first_seen) person.first_seen = value;
  } else if (!person.last_touch || value > person.last_touch) {
    person.last_touch = value;
  }
}

/** Attach a handle, creating the person when it is new. Returns the person id. */
function attach(kind: IdentifierKind, rawValue: string, name = "", iso?: string | null): number | null {
  const value =
    kind === "email" ? normalizeEmail(rawValue) : kind === "phone" ? normalizePhone(rawValue) : rawValue.trim();
  if (!value) return null;
  if (kind === "email" && (SELF.has(value) || isRobotAddress(value))) return null;

  const key = identityKey(kind, value);
  const existing = byIdentifier.get(key);
  if (existing !== undefined) {
    const person = people[existing - 1]!;
    if (name && !person.name) person.name = name;
    touch(person, iso, "last");
    touch(person, iso, "first");
    return existing;
  }

  const person = createPerson(kind === "email" ? value : "");
  person.identifiers.set(key, { kind, value });
  byIdentifier.set(key, person.id);
  if (name) person.name = name;
  if (kind === "email") person.email = value;
  touch(person, iso, "last");
  touch(person, iso, "first");
  return person.id;
}

function merge(targetId: number, sourceId: number) {
  if (targetId === sourceId) return;
  const target = people[targetId - 1]!;
  const source = people[sourceId - 1]!;
  for (const [key, ident] of source.identifiers) {
    target.identifiers.set(key, ident);
    byIdentifier.set(key, targetId);
  }
  if (!target.name) target.name = source.name;
  if (!target.email) target.email = source.email;
  if (!target.company_domain) target.company_domain = source.company_domain;
  target.message_count = Math.max(target.message_count, source.message_count);
  target.meeting_count = Math.max(target.meeting_count, source.meeting_count);
  if (!target.last_touch || (source.last_touch && source.last_touch > target.last_touch)) target.last_touch = source.last_touch;
  if (!target.first_seen || (source.first_seen && source.first_seen < target.first_seen)) target.first_seen = source.first_seen;
  source.identifiers.clear();
  source.email = `merged:${source.id}`;
}

const slug = (value: string) => String(value ?? "").trim().slice(0, 120);

// ---------------------------------------------------------------------------
// 1. Email: mailbox index carries replies, so it goes first.
// ---------------------------------------------------------------------------
console.log("reading corpora…");
const mailbox = readJson<{ contacts: Array<Record<string, unknown>> }>(join(AUDIT, "mailbox-contact-index.json"), { contacts: [] });
for (const c of mailbox.contacts ?? []) {
  const id = attach("email", String(c.email ?? ""), slug(String(c.name ?? "")), String(c.last_seen ?? ""));
  if (!id) continue;
  const person = people[id - 1]!;
  person.message_count += Number(c.inbound ?? 0) + Number(c.outbound ?? 0);
  const inbound = Number(c.inbound ?? 0);
  if (inbound > 0) {
    const evidence = [
      { kind: "email.thread-reply", detail: `they replied on ${inbound} email ${inbound === 1 ? "thread" : "threads"} we have` },
    ];
    const scored = scoreEvidence(evidence);
    facts.push({
      person_id: id,
      field: "replied",
      value: "yes",
      band: scored.band ?? "PROPOSED",
      score: scored.score,
      evidence,
      rationale: scored.rationale,
      status: scored.band === "VERIFIED" ? "APPLIED" : "PROPOSED",
      source_url: null,
      observed_at: String(c.last_seen ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Combined index — brings source labels and WhatsApp chat links.
// ---------------------------------------------------------------------------
const combined = readJson<{ contacts: Array<Record<string, unknown>> }>(join(AUDIT, "combined-email-relationship-index.json"), { contacts: [] });
for (const c of combined.contacts ?? []) {
  attach("email", String(c.email ?? ""), slug(String(c.name ?? "")));
}

// ---------------------------------------------------------------------------
// 3. Fathom — recorded calls. Names here are proposals, not facts.
// ---------------------------------------------------------------------------
const fathom = readJson<{ contacts: Array<Record<string, unknown>> }>(join(AUDIT, "fathom-contact-index.json"), { contacts: [] });
const meetings = new Map<string, { id: string; title: string; ended_at: string; attendees: string[]; url: string }>();
for (const c of fathom.contacts ?? []) {
  const email = String(c.email ?? "");
  const name = slug(String(c.name ?? ""));
  const meetingList = Array.isArray(c.meetings) ? (c.meetings as Array<Record<string, unknown>>) : [];
  const hadEmail = Boolean(email && !SELF.has(normalizeEmail(email)) && !isRobotAddress(email));
  const id = hadEmail ? attach("email", email, name) : attach("fathom_attendee", name);
  if (!id) continue;
  const person = people[id - 1]!;
  person.meeting_count += meetingList.length;

  for (const m of meetingList) {
    const meetingId = String(m.id ?? "");
    if (!meetingId) continue;
    const existing = meetings.get(meetingId);
    const attendee = hadEmail ? normalizeEmail(email) : name;
    if (existing) {
      if (attendee && !existing.attendees.includes(attendee)) existing.attendees.push(attendee);
    } else {
      meetings.set(meetingId, {
        id: meetingId,
        title: slug(String(m.title ?? "")),
        ended_at: String(m.date ?? "").slice(0, 10),
        attendees: attendee ? [attendee] : [],
        url: String(m.url ?? ""),
      });
    }
    touch(person, String(m.date ?? ""), "last");
    touch(person, String(m.date ?? ""), "first");
  }

  // A name that arrived only through a recorded meeting is a suggestion the
  // human accepts — exactly what the evidence ledger is for.
  if (!hadEmail && name) {
    const evidence = [
      {
        kind: "fathom.meeting-attendance",
        detail: `listed as ${name} on ${meetingList.length} recorded ${meetingList.length === 1 ? "call" : "calls"}`,
      },
    ];
    const scored = scoreEvidence(evidence);
    if (scored.band) {
      facts.push({
        person_id: id,
        field: "name",
        value: name,
        band: scored.band,
        score: scored.score,
        evidence,
        rationale: scored.rationale,
        status: "PROPOSED",
        source_url: null,
        observed_at: new Date().toISOString().slice(0, 10),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. WhatsApp contacts — phone + JID + the privacy handle.
// ---------------------------------------------------------------------------
const whatsapp = readJson<{ contacts: Array<Record<string, unknown>> }>(join(AUDIT, "whatsapp-contact-index.json"), { contacts: [] });
for (const c of whatsapp.contacts ?? []) {
  const name = slug(String(c.ZFULLNAME ?? ""));
  const jid = String(c.ZWHATSAPPID ?? "");
  const phone = String(c.ZPHONENUMBER ?? "");
  const decoded = decodeJid(jid);
  let id = phone ? attach("phone", phone, name) : null;
  if (decoded && !decoded.isGroup) {
    const jidId = attach("wa_jid", decoded.jid, name);
    if (id && jidId && id !== jidId) {
      merge(id, jidId);
    } else if (!id) {
      id = jidId;
    }
  }
  const lid = String(c.ZLID ?? "");
  if (id && lid) {
    // A LID is an alias for an identity we already have — recorded so the same
    // thread never forks into a second person.
    const person = people[id - 1]!;
    const key = identityKey("wa_jid", lid);
    if (!byIdentifier.has(key)) {
      person.identifiers.set(key, { kind: "wa_jid", value: lid });
      byIdentifier.set(key, id);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. The CRM directory — also the reconnect queue.
// ---------------------------------------------------------------------------
interface DirectoryRecord {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  chatId?: number | null;
  company?: string;
  lane?: string;
  stage?: string;
  evidence?: string;
  nextAction?: string;
  source?: string;
  suppressed?: boolean;
  reconnectCohort?: string;
  reconnectPriority?: number;
  reconnectDraft?: string;
  draftStatus?: string;
  conversationFirst?: string;
  conversationLast?: string;
  conversationEvidence?: string;
  conversationCounts?: { inboundObserved?: number; outboundObserved?: number };
  historyLinks?: string[];
}

const directory = readJson<DirectoryRecord[]>(join(REF, "revenue-desk", "directory-preview.json"), []);
const reconnectRows: DirectoryRecord[] = [];
for (const record of directory) {
  const email = String(record.email ?? "");
  const phone = String(record.phone ?? "");
  let id: number | null = null;
  if (email) id = attach("email", email, slug(record.name ?? ""));
  if (!id && phone) id = attach("phone", phone, slug(record.name ?? ""));
  if (id) {
    const person = people[id - 1]!;
    if (record.company && !person.company) person.company = slug(record.company);
    touch(person, record.conversationLast ?? null, "last");
  }
  if (record.reconnectCohort || record.suppressed) reconnectRows.push(record);
}

// ---------------------------------------------------------------------------
// 6. Messages and events give the graph its pulse.
// ---------------------------------------------------------------------------
const live = readJson<{ messages: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; sync_state?: Array<Record<string, unknown>> }>(
  join(HERE, "..", "data", "live.json"),
  { messages: [], events: [] },
);

const displayNames = new Map<string, string>();

for (const m of live.messages ?? []) {
  const iso = String(m.internal_date ?? "");
  const from = String(m.from_addr ?? "");
  const to = String(m.to_addr ?? "");
  const self = m.last_from_user ? 1 : 0;

  // The display name a person's own mail carries is a weak-but-real signal:
  // enough to propose, never enough to write without the human saying so.
  for (const addr of [from, to]) {
    const parsed = parseAddress(addr);
    if (parsed.email && parsed.name && !displayNames.has(parsed.email)) displayNames.set(parsed.email, parsed.name);
  }

  for (const [addr, isSender] of [
    [to, false],
    [from, true],
  ] as Array<[string, boolean]>) {
    if (!addr) continue;
    const id = attach("email", addr);
    if (!id) continue;
    const person = people[id - 1]!;
    if (isSender || self === 0) person.message_count += 1;
    touch(person, iso, "last");
    touch(person, iso, "first");
  }
}

for (const e of live.events ?? []) {
  const iso = String(e.start_at ?? "");
  const attendees = String(e.attendees ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const organizer = String(e.organizer ?? "").trim();
  for (const addr of [...attendees, organizer]) {
    const id = attach("email", addr);
    if (!id) continue;
    const person = people[id - 1]!;
    person.meeting_count += 1;
    touch(person, iso, "last");
    touch(person, iso, "first");
  }
}

// Suggested names from the mail itself: PROBABLE, so they land as proposals.
for (const person of people) {
  if (person.identifiers.size === 0) continue;
  // Many imports carry the address as the "name" — that is not a name.
  const named = person.name && person.name.trim().toLowerCase() !== person.email.trim().toLowerCase();
  if (named) continue;
  const suggestion = person.email ? displayNames.get(person.email) : undefined;
  if (!suggestion || suggestion.trim().toLowerCase() === person.email) continue;
  const evidence = [{ kind: "email.signature-block", detail: `their mail arrives as "${suggestion}"` }];
  const scored = scoreEvidence(evidence);
  if (!scored.band) continue;
  const already = facts.some((f) => f.person_id === person.id && f.field === "name");
  if (already) continue;
  facts.push({
    person_id: person.id,
    field: "name",
    value: suggestion,
    band: scored.band,
    score: scored.score,
    evidence,
    rationale: scored.rationale,
    status: "PROPOSED",
    source_url: null,
    observed_at: new Date().toISOString().slice(0, 10),
  });
}

// ---------------------------------------------------------------------------
// 7. Emit SQL
// ---------------------------------------------------------------------------
const esc = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
};

const statements: string[] = [];
const now = new Date().toISOString();

statements.push("-- Generated by packages/seed/src/build.ts from the real corpora.");
statements.push("PRAGMA defer_foreign_keys = true;");

for (const person of people) {
  if (person.identifiers.size === 0) continue;
  const email = person.email && !person.email.startsWith("merged:") ? person.email : "";
  statements.push(
    `INSERT OR REPLACE INTO people (id, email, name, title, company, company_domain, location, human_fields, first_seen, last_touch, message_count, meeting_count, created_at, updated_at) VALUES (` +
      [
        person.id,
        esc(email),
        esc(person.name),
        esc(person.title),
        esc(person.company),
        esc(person.company_domain),
        esc(person.location),
        esc(JSON.stringify(person.human_fields)),
        esc(person.first_seen),
        esc(person.last_touch),
        person.message_count,
        person.meeting_count,
        esc(now),
        esc(now),
      ].join(", ") +
      ");",
  );
  for (const ident of person.identifiers.values()) {
    statements.push(
      `INSERT OR IGNORE INTO person_identifiers (person_id, kind, value, created_at) VALUES (${person.id}, ${esc(
        ident.kind,
      )}, ${esc(ident.value)}, ${esc(now)});`,
    );
  }
}

const seenFacts = new Set<string>();
for (const fact of facts) {
  const key = `${fact.person_id}|${fact.field}|${fact.value}`;
  if (seenFacts.has(key)) continue;
  seenFacts.add(key);
  statements.push(
    `INSERT OR REPLACE INTO person_facts (person_id, field, value, band, score, evidence, rationale, status, source_url, observed_at, created_at, updated_at) VALUES (` +
      [
        fact.person_id,
        esc(fact.field),
        esc(fact.value),
        esc(fact.band),
        fact.score,
        esc(JSON.stringify(fact.evidence)),
        esc(fact.rationale),
        esc(fact.status),
        esc(fact.source_url),
        esc(fact.observed_at),
        esc(now),
        esc(now),
      ].join(", ") +
      ");",
  );
}

for (const m of live.messages ?? []) {
  statements.push(
    `INSERT OR REPLACE INTO messages (id, service, thread_id, from_addr, to_addr, subject, snippet, body_text, labels, is_unread, last_from_user, internal_date, synced_at) VALUES (` +
      [
        esc(m.id),
        esc(m.service ?? "gmail"),
        esc(m.thread_id),
        esc(m.from_addr),
        esc(m.to_addr),
        esc(m.subject),
        esc(m.snippet),
        esc(m.body_text),
        esc(m.labels ?? ""),
        Number(m.is_unread ?? 0) ? 1 : 0,
        Number(m.last_from_user ?? 0) ? 1 : 0,
        esc(m.internal_date),
        esc(now),
      ].join(", ") +
      ");",
  );
}

for (const e of live.events ?? []) {
  statements.push(
    `INSERT OR REPLACE INTO events (id, service, title, start_at, end_at, is_all_day, location, organizer, attendees, status, link, synced_at) VALUES (` +
      [
        esc(e.id),
        esc(e.service ?? "google-calendar"),
        esc(e.title),
        esc(e.start_at),
        esc(e.end_at),
        Number(e.is_all_day ?? 0) ? 1 : 0,
        esc(e.location),
        esc(e.organizer),
        esc(e.attendees ?? ""),
        esc(e.status),
        esc(e.link),
        esc(now),
      ].join(", ") +
      ");",
  );
}

for (const meeting of meetings.values()) {
  statements.push(
    `INSERT OR REPLACE INTO meetings (id, title, ended_at, attendees, summary, action_items, url) VALUES (` +
      [esc(meeting.id), esc(meeting.title), esc(meeting.ended_at), esc(JSON.stringify(meeting.attendees)), "''", "'[]'", esc(meeting.url)].join(", ") +
      ");",
  );
}

for (const record of reconnectRows) {
  const cohort = String(record.reconnectCohort ?? (record.suppressed ? "Excluded" : "Saved contact — no exchange verified"));
  const counts = record.conversationCounts ?? {};
  statements.push(
    `INSERT OR REPLACE INTO reconnect (contact_id, name, email, phone, chat_id, company, lane, stage, cohort, cohort_rank, priority, signal, action, conversation_first, conversation_last, conversation_evidence, inbound, outbound, draft, draft_status, history_links, suppressed, updated_at) VALUES (` +
      [
        esc(record.id),
        esc(slug(record.name ?? "")),
        esc(normalizeEmail(String(record.email ?? ""))),
        esc(normalizePhone(String(record.phone ?? ""))),
        esc(record.chatId ?? null),
        esc(slug(record.company ?? "")),
        esc(slug(record.lane ?? "")),
        esc(slug(record.stage ?? "")),
        esc(cohort),
        COHORT_RANK[cohort] ?? 80,
        Number(record.reconnectPriority ?? 80),
        esc(String(record.evidence ?? "").slice(0, 900)),
        esc(String(record.nextAction ?? "").slice(0, 900)),
        esc(record.conversationFirst ?? null),
        esc(record.conversationLast ?? null),
        esc(String(record.conversationEvidence ?? "")),
        Number(counts.inboundObserved ?? 0),
        Number(counts.outboundObserved ?? 0),
        esc(String(record.reconnectDraft ?? "")),
        esc(String(record.draftStatus ?? "")),
        esc(JSON.stringify(record.historyLinks ?? [])),
        record.suppressed ? 1 : 0,
        esc(now),
      ].join(", ") +
      ");",
  );
}

const newestMessage = (live.messages ?? [])
  .map((m) => String(m.internal_date ?? ""))
  .sort()
  .at(-1);
const newestEvent = (live.events ?? []).map((e) => String(e.start_at ?? "")).sort().at(-1);
const newestMeeting = [...meetings.values()].map((m) => m.ended_at).filter(Boolean).sort().at(-1);

const connectionRows: Array<[string, string, string, string, string | null, number, string]> = [
  [
    "gmail",
    "Gmail",
    "stale",
    newestMessage ?? null,
    (live.messages ?? []).length,
    "Imported from the AIOS workspace snapshot. Run connectors/ locally to refresh — a Worker cannot hold a Gmail session.",
  ],
  [
    "google-calendar",
    "Google Calendar",
    "stale",
    newestEvent ?? null,
    (live.events ?? []).length,
    "Imported from the AIOS workspace snapshot (meetings you organised or attended).",
  ],
  [
    "whatsapp",
    "WhatsApp (personal)",
    "stale",
    null,
    whatsapp.contacts?.length ?? 0,
    `${whatsapp.contacts?.length ?? 0} contacts indexed from the audit. No message bodies in this snapshot — WhatsApp ingest runs locally.`,
  ],
  [
    "fathom",
    "Fathom calls",
    "stale",
    newestMeeting ?? null,
    meetings.size,
    `${meetings.size} recorded meetings imported from the Fathom audit index (titles, dates, attendees — no transcripts).`,
  ],
  ["slack", "Slack", "not_configured", null, 0, "No Slack workspace connected in this snapshot."],
  ["stripe", "Stripe", "not_configured", null, 0, "No invoicing source connected."],
  [
    "revenue-desk",
    "Revenue Desk CRM",
    "stale",
    "2026-09-08",
    reconnectRows.length,
    "Imported from the Revenue Desk export (2026-09-08): stages, cohorts, drafts and the two locked exclusions.",
  ],
];

for (const [id, label, status, lastSync, count, detail] of connectionRows) {
  statements.push(
    `INSERT OR REPLACE INTO connections (id, source, label, status, last_sync_at, item_count, detail) VALUES (` +
      [esc(id), esc(id), esc(label), esc(status), esc(lastSync), count, esc(detail)].join(", ") +
      ");",
  );
}

statements.push(
  `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('agents_paused', 'false');`,
);
statements.push(
  `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('seeded_at', ${esc(now)});`,
);

// ---- chunked output -------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const MAX_BYTES = 3.5 * 1024 * 1024;
let chunk: string[] = [];
let chunkBytes = 0;
let fileIndex = 0;
const files: string[] = [];

const flush = () => {
  if (chunk.length === 0) return;
  fileIndex += 1;
  const name = `seed-${String(fileIndex).padStart(2, "0")}.sql`;
  writeFileSync(join(OUT, name), chunk.join("\n") + "\n");
  files.push(name);
  chunk = [];
  chunkBytes = 0;
};

for (const statement of statements) {
  chunk.push(statement);
  chunkBytes += statement.length + 1;
  if (chunkBytes >= MAX_BYTES) flush();
}
flush();

const applied = facts.filter((f) => f.status === "APPLIED").length;
const proposed = facts.filter((f) => f.status === "PROPOSED").length;
const stats = {
  people: people.filter((p) => p.identifiers.size > 0).length,
  identifiers: people.reduce((n, p) => n + p.identifiers.size, 0),
  facts: { total: facts.length, applied, proposed },
  messages: (live.messages ?? []).length,
  events: (live.events ?? []).length,
  meetings: meetings.size,
  reconnect: reconnectRows.length,
  reconnectActive: reconnectRows.filter((r) => !r.suppressed && (COHORT_RANK[String(r.reconnectCohort)] ?? 80) <= 30).length,
  suppressed: reconnectRows.filter((r) => r.suppressed).length,
  files,
  generated_at: now,
};

writeFileSync(join(OUT, "stats.json"), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
console.log(`\nwrote ${files.length} file(s) to packages/seed/out/`);
