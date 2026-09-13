import type { D1Like, ToolContext } from "@rel/core";
import type { ChatTurn, StreamingAiBinding } from "./ai";
import { GROUNDED_SYSTEM, all, first, handlers, personDetail } from "./tools/handlers";

/**
 * Ask — a conversation with the graph.
 *
 * The rule the whole product runs on still holds here: an answer may only draw on
 * the record, and when the record is silent the answer says so. What is new is
 * that the record is assembled per question — people the question names, plus the
 * standing digest of what is waiting on a human — and that the answer streams.
 *
 * Conversations are saved (chat_threads / chat_messages) so an answer can be
 * reopened later without re-asking, and so a follow-up has its history.
 */

export interface GroundedOn {
  people: number;
  facts: number;
  messages: number;
  sources: number;
  chars: number;
  person?: { id: number; name: string };
}

export interface ContextResult {
  record: string;
  grounded: GroundedOn;
  people: Array<{ id: number; name: string }>;
}

export interface ChatThread {
  id: number;
  title: string;
  person_id: number | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  person_name?: string | null;
  preview?: string;
}

export interface ChatMessage {
  id: number;
  thread_id: number;
  role: "user" | "assistant";
  content: string;
  grounded_on: GroundedOn | Record<string, never>;
  model: string | null;
  created_at: string;
}

const CHAT_SYSTEM =
  `${GROUNDED_SYSTEM} You are answering in a conversation: earlier turns are supplied above, and you may refer to ` +
  `them, but the record in the final message is still the only source of facts. Keep it short — a few tight ` +
  `paragraphs or bullets, never padding, and name the person and the trace you are drawing on.`;

/** The record is the only context; it also has to fit. */
const RECORD_CAP = 12_000;
const HISTORY_TURNS = 8;

/** Words that are noise in a name search, not signals. */
const STOPWORDS = new Set([
  "the", "and", "for", "who", "what", "when", "where", "why", "how", "with", "about", "into", "from", "that", "this",
  "these", "those", "are", "was", "were", "has", "have", "had", "should", "would", "could", "can", "will", "does",
  "did", "not", "but", "his", "her", "him", "she", "they", "them", "their", "you", "your", "our", "its", "been",
  "being", "more", "most", "some", "any", "all", "one", "get", "got", "know", "tell", "show", "give", "make", "made",
  "need", "want", "like", "much", "many", "last", "next", "week", "month", "year", "today", "now", "recent",
  "recently", "people", "person", "someone", "anyone", "thing", "things", "graph", "again", "back", "there", "here",
]);

interface PersonLite {
  id: number;
  name: string;
  email?: string;
  title?: string;
  company?: string;
  company_domain?: string;
  last_touch?: string | null;
}

function tokens(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 8);
}

/** Some rows carry an address list where a name should be — never quote those. */
function brokenName(name: string): boolean {
  return !name || name.includes("@") || name.includes(",") || name.length > 80;
}

/** What to call a person in the record, without repeating a bad row. */
function displayName(person: PersonLite): string {
  if (!brokenName(person.name)) return person.name;
  const email = String(person.email ?? "").trim();
  if (email && !email.includes(",")) return email.split("@")[0]!;
  return `person #${person.id}`;
}

/**
 * People the question might be about — deterministic, no model in the loop.
 * A match on the name or the company counts; a match inside a domain or an
 * address alone does not, or a question containing "…connect…" would drag in
 * rows that merely have it in their email.
 */
async function probePeople(ctx: ToolContext, question: string, carryPersonId: number | null): Promise<PersonLite[]> {
  const found = new Map<number, { person: PersonLite; score: number }>();

  for (const word of tokens(question).slice(0, 5)) {
    const res = (await handlers.search_people!(ctx, { query: word, limit: 8 })) as { people?: PersonLite[] };
    for (const person of res.people ?? []) {
      if (brokenName(String(person.name ?? ""))) continue;

      const name = String(person.name ?? "").toLowerCase();
      const company = String(person.company ?? "").toLowerCase();
      const at = String(person.email ?? "").toLowerCase();
      const domain = String(person.company_domain ?? "").toLowerCase();

      let score = 0;
      if (name.includes(word)) score += 3;
      if (company.includes(word)) score += 2;
      if (at.includes(word) || domain.includes(word)) score += 1;
      if (word.includes("@")) score += 1; // asking by address is deliberate
      if (score < 2) continue;

      const existing = found.get(person.id);
      if (!existing || existing.score < score) found.set(person.id, { person, score });
    }
  }

  if (carryPersonId && !found.has(carryPersonId)) {
    const res = (await handlers.get_person!(ctx, { person_id: carryPersonId })) as { person?: PersonLite };
    if (res?.person?.id) found.set(res.person.id, { person: res.person, score: 99 });
  }

  return [...found.values()]
    .sort(
      (a, b) =>
        b.score - a.score || String(b.person.last_touch ?? "").localeCompare(String(a.person.last_touch ?? "")),
    )
    .map((entry) => entry.person)
    .slice(0, 6);
}

function capped(parts: string[]): string {
  const record = parts.filter(Boolean).join("\n");
  if (record.length <= RECORD_CAP) return record;
  return `${record.slice(0, RECORD_CAP)}\n… (record truncated at ${RECORD_CAP} characters)`;
}

/** How many items a brief actually included for a section — counted, never assumed. */
function countBullets(brief: string, section: string): number {
  const block = brief.match(new RegExp(`## ${section}\\n([\\s\\S]*?)(\\n## |$)`));
  return block ? ((block[1] ?? "").match(/^- /gm) ?? []).length : 0;
}

/**
 * Assemble what the model may draw on: the pinned person's full record, or the
 * people the question names plus the standing digest of the graph.
 */
export async function buildContext(
  db: D1Like,
  now: string,
  args: { question: string; personId: number | null; carryPersonId?: number | null },
): Promise<ContextResult> {
  const ctx: ToolContext = { db, now, agent: null, ai: null };
  const parts: string[] = [];

  const pinned = args.personId ?? args.carryPersonId ?? null;
  if (pinned) {
    const detail = await personDetail(db, pinned);
    if (detail) {
      const brief = (await handlers.prep_brief!(ctx, { person_id: pinned })) as { brief?: string };
      const name = displayName({ id: pinned, name: detail.person.name, email: detail.person.email });
      const applied = detail.facts.filter((fact) => fact.status === "APPLIED");
      parts.push("PERSON RECORD (the only thing you may draw on)");
      parts.push(`Person: ${name} (#${pinned})`);
      if (brief?.brief) parts.push(brief.brief);
      if (applied.length) {
        parts.push(`\nFACTS\n${applied.map((fact) => `- ${fact.field}: ${fact.value} (${fact.rationale})`).join("\n")}`);
      }
      const record = capped(parts);
      return {
        record,
        grounded: {
          people: 1,
          facts: applied.length,
          messages: brief?.brief ? countBullets(brief.brief, "Recent email") : 0,
          sources: 0,
          chars: record.length,
          person: { id: pinned, name },
        },
        people: [{ id: pinned, name }],
      };
    }
  }

  const matched = await probePeople(ctx, args.question, args.carryPersonId ?? null);
  let facts = 0;
  let messages = 0;

  if (matched.length) {
    parts.push("PEOPLE THE QUESTION MAY BE ABOUT");
    for (const [index, person] of matched.entries()) {
      const who = [person.title, person.company].filter(Boolean).join(", ");
      if (index < 3) {
        const brief = (await handlers.prep_brief!(ctx, { person_id: person.id })) as { brief?: string };
        parts.push(`\n--- ${displayName(person)} (#${person.id})${who ? ` — ${who}` : ""}`);
        if (brief?.brief) {
          parts.push(brief.brief);
          messages += countBullets(brief.brief, "Recent email");
        }
      } else {
        parts.push(
          `\n--- ${displayName(person)} (#${person.id})${who ? ` — ${who}` : ""} · last touch ${String(person.last_touch ?? "unknown").slice(0, 10)}`,
        );
      }
    }
  }

  const [counts, proposed, reconnect, due, stale] = await Promise.all([
    first<{ people: number; messages: number; meetings: number }>(
      ctx.db,
      `SELECT (SELECT COUNT(*) FROM people) AS people, (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM meetings) AS meetings`,
    ),
    all<{ id: number; field: string; value: string; band: string; name: string; person_id: number }>(
      ctx.db,
      `SELECT f.id, f.field, f.value, f.band, p.name, p.id AS person_id
       FROM person_facts f JOIN people p ON p.id = f.person_id
       WHERE f.status = 'PROPOSED' ORDER BY f.updated_at DESC LIMIT 10`,
    ),
    all<{ name: string; company: string; cohort: string; signal: string; action: string }>(
      ctx.db,
      `SELECT name, company, cohort, signal, action FROM reconnect
       WHERE suppressed = 0 ORDER BY cohort_rank ASC, priority ASC LIMIT 8`,
    ),
    all<{ channel: string; subject: string; followup_at: string; name: string | null }>(
      ctx.db,
      `SELECT o.channel, o.subject, o.followup_at, p.name
       FROM outreach o LEFT JOIN people p ON p.id = o.person_id
       WHERE o.followup_at IS NOT NULL AND o.followup_at <> '' AND o.followup_at <= ?
       ORDER BY o.followup_at ASC LIMIT 10`,
      now.slice(0, 10),
    ),
    all<{ label: string; status: string; last_sync_at: string | null }>(
      ctx.db,
      "SELECT label, status, last_sync_at FROM connections WHERE status IN ('stale', 'error') ORDER BY source",
    ),
  ]);

  if (counts) {
    parts.push(`\nGRAPH: ${counts.people.toLocaleString()} people · ${counts.messages.toLocaleString()} messages · ${counts.meetings.toLocaleString()} recorded calls`);
  }
  if (reconnect.length) {
    parts.push("\nTOP OF THE RECONNECT QUEUE");
    for (const row of reconnect) {
      parts.push(`- ${row.name}${row.company ? ` (${row.company})` : ""} — ${row.cohort}; ${row.signal}${row.action ? `; suggests: ${row.action}` : ""}`);
    }
  }
  if (proposed.length) {
    parts.push(`\nFACTS WAITING ON A HUMAN DECISION (${proposed.length} shown)`);
    for (const fact of proposed) parts.push(`- ${fact.name}: ${fact.field} = ${fact.value} (${fact.band}, id ${fact.id})`);
    facts += proposed.length;
  }
  if (due.length) {
    parts.push("\nFOLLOW-UPS THAT HAVE COME DUE");
    for (const row of due) parts.push(`- ${row.name ?? "unknown"} · ${row.channel}${row.subject ? ` · ${row.subject}` : ""} · due ${row.followup_at}`);
  }
  if (stale.length) {
    parts.push("\nSOURCES THAT ARE NOT FRESH");
    for (const row of stale) parts.push(`- ${row.label}: ${row.status}${row.last_sync_at ? ` (last sync ${row.last_sync_at.slice(0, 10)})` : ""}`);
  }

  const record = capped(parts);

  // Names the digest put in front of the model should be clickable in the answer,
  // so resolve the ones the graph actually holds to their person ids.
  const people = new Map<number, { id: number; name: string }>();
  for (const person of matched) people.set(person.id, { id: person.id, name: displayName(person) });
  for (const fact of proposed) {
    if (fact.person_id && fact.name) people.set(fact.person_id, { id: fact.person_id, name: fact.name });
  }
  const queued = reconnect.map((row) => row.name).filter(Boolean);
  if (queued.length > 0) {
    const rows = await all<{ id: number; name: string }>(
      ctx.db,
      `SELECT id, name FROM people WHERE name IN (${queued.map(() => "?").join(",")}) LIMIT 20`,
      ...queued,
    );
    for (const row of rows) people.set(row.id, { id: row.id, name: row.name });
  }

  return {
    record,
    grounded: {
      people: matched.length,
      facts,
      messages,
      sources: stale.length,
      chars: record.length,
      ...(matched[0] ? { person: { id: matched[0].id, name: displayName(matched[0]) } } : {}),
    },
    people: [...people.values()].slice(0, 10),
  };
}

/** The person this thread was last actually about — so a follow-up has a subject. */
async function carryPerson(db: D1Like, threadId: number): Promise<number | null> {
  const row = await first<{ grounded_on: string }>(
    db,
    "SELECT grounded_on FROM chat_messages WHERE thread_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    threadId,
  );
  if (!row?.grounded_on) return null;
  try {
    const parsed = JSON.parse(row.grounded_on) as GroundedOn;
    return parsed.person?.id ?? null;
  } catch {
    return null;
  }
}

async function recentTurns(db: D1Like, threadId: number): Promise<ChatTurn[]> {
  const rows = await all<{ role: "user" | "assistant"; content: string }>(
    db,
    "SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?",
    threadId,
    HISTORY_TURNS,
  );
  return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
}

/* ---- threads ---- */

export async function listThreads(db: D1Like): Promise<ChatThread[]> {
  const rows = await all<ChatThread>(
    db,
    `SELECT t.id, t.title, t.person_id, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS message_count,
            (SELECT p.name FROM people p WHERE p.id = t.person_id) AS person_name,
            (SELECT m.content FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS preview
     FROM chat_threads t ORDER BY t.updated_at DESC LIMIT 100`,
  );
  return rows.map((row) => ({ ...row, preview: String(row.preview ?? "").slice(0, 140) }));
}

export async function getThread(db: D1Like, id: number): Promise<ChatThread | null> {
  return first<ChatThread>(
    db,
    `SELECT t.id, t.title, t.person_id, t.created_at, t.updated_at,
            (SELECT p.name FROM people p WHERE p.id = t.person_id) AS person_name
     FROM chat_threads t WHERE t.id = ?`,
    id,
  );
}

export async function getMessages(db: D1Like, threadId: number): Promise<ChatMessage[]> {
  const rows = await all<ChatMessage & { grounded_on: string }>(
    db,
    "SELECT id, thread_id, role, content, grounded_on, model, created_at FROM chat_messages WHERE thread_id = ? ORDER BY id",
    threadId,
  );
  return rows.map((row) => ({ ...row, grounded_on: safeGrounded(row.grounded_on) }));
}

function safeGrounded(raw: unknown): GroundedOn | Record<string, never> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as GroundedOn;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function createThread(db: D1Like, now: string, personId: number | null, title = "New conversation"): Promise<ChatThread> {
  const result = await db
    .prepare("INSERT INTO chat_threads (title, person_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(title, personId, now, now)
    .run();
  const id = Number(result.meta?.last_row_id ?? 0);
  const thread = await getThread(db, id);
  return thread ?? { id, title, person_id: personId, created_at: now, updated_at: now };
}

export async function deleteThread(db: D1Like, id: number): Promise<boolean> {
  await db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").bind(id).run();
  const result = await db.prepare("DELETE FROM chat_threads WHERE id = ?").bind(id).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function appendMessage(
  db: D1Like,
  now: string,
  threadId: number,
  role: "user" | "assistant",
  content: string,
  groundedOn: GroundedOn | Record<string, never>,
  model: string | null,
): Promise<number | null> {
  const result = await db
    .prepare("INSERT INTO chat_messages (thread_id, role, content, grounded_on, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(threadId, role, content, JSON.stringify(groundedOn ?? {}), model, now)
    .run();
  const id = Number(result.meta?.last_row_id ?? 0);
  return id > 0 ? id : null;
}

async function touchThread(db: D1Like, now: string, threadId: number, title?: string): Promise<void> {
  if (title) {
    await db.prepare("UPDATE chat_threads SET updated_at = ?, title = ? WHERE id = ?").bind(now, title, threadId).run();
    return;
  }
  await db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").bind(now, threadId).run();
}

/* ---- the stream ---- */

export function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The answer as a Server-Sent Event stream: `context` (what it will draw on, so
 * the screen can say it honestly) → `delta` (text, as it is written) → `done`
 * (what it was grounded on, and the ids to reopen it with). A failure mid-answer
 * keeps whatever was written rather than losing the turn.
 */
export function chatResponse(opts: {
  db: D1Like;
  ai: StreamingAiBinding;
  now: string;
  threadId: number;
  personId: number | null;
  question: string;
}): Response {
  const { db, ai, now, threadId, question, personId } = opts;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = "";
      const send = (event: string, data: unknown) => controller.enqueue(sse(event, data));

      try {
        const history = await recentTurns(db, threadId);
        const carry = await carryPerson(db, threadId);
        await appendMessage(db, now, threadId, "user", question, {}, null);

        const context = await buildContext(db, now, { question, personId, carryPersonId: carry });

        send("context", {
          thread_id: threadId,
          grounded: context.grounded,
          people: context.people,
          person: context.grounded.person ?? null,
          model: ai.model,
        });

        const messages: ChatTurn[] = [
          { role: "system", content: CHAT_SYSTEM },
          ...history,
          { role: "user", content: `${context.record}\n\nQUESTION: ${question}` },
        ];

        const reader = (await ai.runStream({ messages })).getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) {
            answer += chunk.value;
            send("delta", { text: chunk.value });
          }
        }

        const finalText =
          answer.trim() ||
          "The model returned no answer — it may have spent its whole budget reasoning. Try again, or ask a narrower question.";
        const messageId = await appendMessage(db, new Date().toISOString(), threadId, "assistant", finalText, context.grounded, ai.model);
        await touchThread(db, new Date().toISOString(), threadId);

        send("done", {
          thread_id: threadId,
          message_id: messageId,
          grounded_on: context.grounded,
          people: context.people,
          model: ai.model,
        });
      } catch (error) {
        // Keep the partial answer: a stopped generation is still a turn.
        if (answer.trim()) {
          try {
            await appendMessage(db, new Date().toISOString(), threadId, "assistant", `${answer.trim()}`, {}, ai.model);
          } catch {
            // best effort — the screen already has the text
          }
        }
        try {
          send("error", { error: error instanceof Error ? error.message : String(error) });
        } catch {
          // client is gone
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

/** The first question becomes the title — the only honest, free option. */
export function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean || "New conversation";
}

export { HISTORY_TURNS };
