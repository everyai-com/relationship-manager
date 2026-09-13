import {
  labelsFor,
  ROW_FIELDS,
  scoreEvidence,
  type D1Like,
  type Fact,
  type IdentifierKind,
  type Identifiers,
  type ToolHandlers,
} from "@rel/core";

/** Small query helpers — kept thin so every handler reads like the SQL it runs. */
async function all<T>(db: D1Like, sql: string, ...args: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...args).all<T>();
  return (res.results ?? []) as T[];
}
async function first<T>(db: D1Like, sql: string, ...args: unknown[]): Promise<T | null> {
  return ((await db.prepare(sql).bind(...args).first<T>()) ?? null) as T | null;
}
async function run(db: D1Like, sql: string, ...args: unknown[]) {
  return db.prepare(sql).bind(...args).run();
}

const emptyIdentifiers = (): Identifiers => ({ emails: [], phones: [], wa_jids: [], fathom: [] });

async function identifiersFor(db: D1Like, personIds: number[]): Promise<Record<number, Identifiers>> {
  const out: Record<number, Identifiers> = {};
  if (personIds.length === 0) return out;
  const placeholders = personIds.map(() => "?").join(",");
  const rows = await all<{ person_id: number; kind: IdentifierKind; value: string }>(
    db,
    `SELECT person_id, kind, value FROM person_identifiers WHERE person_id IN (${placeholders}) ORDER BY kind, value`,
    ...personIds,
  );
  for (const id of personIds) out[id] = emptyIdentifiers();
  for (const r of rows) {
    const bucket = out[r.person_id] ?? (out[r.person_id] = emptyIdentifiers());
    if (r.kind === "email") bucket.emails.push(r.value);
    else if (r.kind === "phone") bucket.phones.push(r.value);
    else if (r.kind === "wa_jid") bucket.wa_jids.push(r.value);
    else if (r.kind === "fathom_attendee") bucket.fathom.push(r.value);
  }
  return out;
}

function toFact(row: Record<string, unknown>): Fact {
  let evidence: Array<{ kind: string; detail?: string }> = [];
  try {
    const parsed = JSON.parse(String(row.evidence ?? "[]"));
    if (Array.isArray(parsed)) evidence = parsed;
  } catch {
    evidence = [];
  }
  return {
    id: Number(row.id),
    person_id: Number(row.person_id),
    field: String(row.field ?? ""),
    value: String(row.value ?? ""),
    band: row.band as Fact["band"],
    score: Number(row.score ?? 0),
    rationale: String(row.rationale ?? ""),
    reasons: labelsFor(evidence),
    evidence,
    status: row.status as Fact["status"],
    source_url: (row.source_url as string | null) ?? null,
    observed_at: (row.observed_at as string | null) ?? null,
  };
}

function day(value: unknown): string {
  const s = String(value ?? "");
  return s ? s.slice(0, 10) : "";
}

interface PersonRow {
  id: number;
  email: string;
  name: string;
  title: string;
  company: string;
  company_domain: string;
  location: string;
  human_fields: string;
  last_touch: string | null;
  first_seen: string | null;
  message_count: number;
  meeting_count: number;
}

function shapeRow(r: PersonRow & { proposed_count: number }) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    title: r.title,
    company: r.company,
    company_domain: r.company_domain,
    last_touch: r.last_touch,
    first_seen: r.first_seen,
    message_count: r.message_count,
    meeting_count: r.meeting_count,
    proposed_count: r.proposed_count,
  };
}

async function personOr404(db: D1Like, id: number): Promise<PersonRow | null> {
  return first<PersonRow>(db, "SELECT * FROM people WHERE id = ?", id);
}

async function personDetail(db: D1Like, id: number) {
  const person = await personOr404(db, id);
  if (!person) return null;

  const factRows = await all<Record<string, unknown>>(
    db,
    "SELECT * FROM person_facts WHERE person_id = ? AND status IN ('APPLIED','PROPOSED') ORDER BY status, field, updated_at DESC",
    id,
  );
  const identifiers = (await identifiersFor(db, [id]))[id] ?? emptyIdentifiers();

  const like = `%${person.email}%`;
  const messages = await all<Record<string, unknown>>(
    db,
    "SELECT id, thread_id, subject, snippet, from_addr, to_addr, internal_date FROM messages WHERE from_addr LIKE ? OR to_addr LIKE ? ORDER BY internal_date DESC LIMIT 20",
    like,
    like,
  );
  const events = await all<Record<string, unknown>>(
    db,
    "SELECT id, title, start_at, end_at, attendees, organizer FROM events WHERE attendees LIKE ? OR organizer LIKE ? ORDER BY start_at DESC LIMIT 10",
    like,
    like,
  );

  return {
    person: { ...person, identifiers, human_fields: safeJsonArray(person.human_fields) },
    facts: factRows.map(toFact),
    identifiers,
    messages,
    events,
  };
}

function safeJsonArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function whatsappSnippets(db: D1Like, jids: string[], limit = 6) {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => "?").join(",");
  const rows = await all<{ snippet: string; last_from_user: number; internal_date: string }>(
    db,
    `SELECT snippet, last_from_user, internal_date FROM messages WHERE service LIKE 'whatsapp:%' AND thread_id IN (${placeholders}) ORDER BY internal_date DESC LIMIT ?`,
    ...jids,
    limit,
  );
  return rows.map((r) => ({ text: r.snippet ?? "", fromMe: Boolean(r.last_from_user), at: r.internal_date }));
}

async function fathomForPerson(db: D1Like, ids: Identifiers) {
  const emails = new Set(ids.emails.map((e) => e.toLowerCase()));
  const names = new Set(ids.fathom.map((n) => n.trim().toLowerCase()));
  if (emails.size === 0 && names.size === 0) return [];
  const rows = await all<{ id: string; title: string; ended_at: string; attendees: string; summary: string; action_items: string; url: string }>(
    db,
    "SELECT id, title, ended_at, attendees, summary, action_items, url FROM meetings ORDER BY ended_at DESC LIMIT 200",
  );
  const out: Array<{ title: string; endedAt: string; summary: string; actionItems: string[]; url: string }> = [];
  for (const meeting of rows) {
    const attendees = safeJsonArray(meeting.attendees);
    const matched = attendees.some((raw) => {
      const a = String(raw ?? "").trim().toLowerCase();
      return (a.includes("@") && emails.has(a)) || names.has(a);
    });
    if (!matched) continue;
    out.push({
      title: meeting.title || "(untitled meeting)",
      endedAt: day(meeting.ended_at),
      summary: String(meeting.summary ?? "").trim(),
      actionItems: safeJsonArray(meeting.action_items).slice(0, 6),
      url: meeting.url ?? "",
    });
  }
  return out;
}

export const handlers: ToolHandlers = {
  async search_people(ctx, args) {
    const query = String(args.query ?? "").trim();
    const limit = Math.min(Number(args.limit ?? 25) || 25, 200);

    if (!query) {
      // No query means "who have I been talking to lately" — the natural first
      // question, and the only one an agent can ask without a keyword.
      const rows = await all<PersonRow & { proposed_count: number }>(
        ctx.db,
        `SELECT p.*, (SELECT COUNT(*) FROM person_facts f WHERE f.person_id = p.id AND f.status = 'PROPOSED') AS proposed_count
         FROM people p
         WHERE p.last_touch IS NOT NULL
         ORDER BY p.last_touch DESC
         LIMIT ?`,
        limit,
      );
      const ids = await identifiersFor(ctx.db, rows.map((r) => r.id));
      return { people: rows.map((r) => ({ ...shapeRow(r), identifiers: ids[r.id] ?? emptyIdentifiers() })) };
    }

    const like = `%${query}%`;
    const rows = await all<PersonRow & { proposed_count: number }>(
      ctx.db,
      `SELECT p.*, (SELECT COUNT(*) FROM person_facts f WHERE f.person_id = p.id AND f.status = 'PROPOSED') AS proposed_count
       FROM people p
       WHERE p.name LIKE ? OR p.email LIKE ? OR p.company LIKE ? OR p.company_domain LIKE ?
       ORDER BY (p.last_touch IS NULL), p.last_touch DESC, p.name
       LIMIT ?`,
      like,
      like,
      like,
      like,
      limit,
    );
    const ids = await identifiersFor(ctx.db, rows.map((r) => r.id));
    return { people: rows.map((r) => ({ ...shapeRow(r), identifiers: ids[r.id] ?? emptyIdentifiers() })) };
  },

  async get_person(ctx, args) {
    const detail = await personDetail(ctx.db, Number(args.person_id));
    if (!detail) return { error: "person not found" };
    return detail;
  },

  async prep_brief(ctx, args) {
    const detail = await personDetail(ctx.db, Number(args.person_id));
    if (!detail) return { error: "person not found" };
    const { person, facts, messages, events, identifiers } = detail;

    const lines = [`# Prep: ${person.name || person.email}`];
    const who = [person.title, person.company || person.company_domain].filter(Boolean).join(", ");
    if (who) lines.push(who);

    const reach = [
      ...identifiers.wa_jids.map((j) => `WhatsApp ${j}`),
      ...identifiers.phones.map((p) => `phone ${p}`),
      ...identifiers.emails.filter((e) => e !== person.email),
    ];
    if (reach.length) {
      lines.push("\n## Reachable on", ...reach.map((r) => `- ${r}`));
    }

    const applied = facts.filter((f) => f.status === "APPLIED");
    if (applied.length) {
      lines.push("\n## What we know", ...applied.map((f) => `- ${f.field}: ${f.value} (${f.rationale})`));
    }

    if (messages.length) {
      lines.push("\n## Recent email", ...messages.slice(0, 5).map((m) => `- ${day(m.internal_date)} — ${m.subject || "(no subject)"}`));
    }
    if (events.length) {
      lines.push("\n## Meetings", ...events.slice(0, 5).map((e) => `- ${day(e.start_at)} — ${e.title || "(untitled)"}`));
    }

    if (identifiers.wa_jids.length) {
      const wa = await whatsappSnippets(ctx.db, identifiers.wa_jids);
      lines.push("\n## WhatsApp");
      if (wa.length === 0) {
        lines.push("Connected on WhatsApp, but no messages ingested yet.");
      } else {
        for (const w of wa) {
          lines.push(`- ${day(w.at)} (${w.fromMe ? "you" : "them"}): ${w.text || ""}`);
        }
      }
    }

    const fathom = await fathomForPerson(ctx.db, identifiers);
    if (fathom.length) {
      lines.push("\n## Recorded calls");
      for (const f of fathom.slice(0, 3)) {
        lines.push(`- ${[f.endedAt, f.title].filter(Boolean).join(" — ")}`);
        if (f.summary) lines.push(`  ${f.summary.slice(0, 400)}`);
        for (const item of f.actionItems) lines.push(`  action item: ${item}`);
      }
    }

    if (lines.length === 1) lines.push("Nothing on file yet beyond the address itself.");
    return { brief: lines.join("\n") };
  },

  async person_timeline(ctx, args) {
    const id = Number(args.person_id);
    const limit = Math.min(Number(args.limit ?? 40) || 40, 200);
    const person = await personOr404(ctx.db, id);
    if (!person) return { error: "person not found" };
    const ids = (await identifiersFor(ctx.db, [id]))[id] ?? emptyIdentifiers();
    const like = `%${person.email}%`;

    const entries: Array<Record<string, unknown>> = [];

    for (const m of await all<Record<string, unknown>>(
      ctx.db,
      "SELECT id, thread_id, subject, snippet, from_addr, to_addr, internal_date, service FROM messages WHERE service = 'gmail' AND (from_addr LIKE ? OR to_addr LIKE ?) ORDER BY internal_date DESC LIMIT ?",
      like,
      like,
      limit,
    )) {
      entries.push({
        kind: "email",
        id: m.id,
        title: m.subject || "(no subject)",
        detail: `${m.from_addr ?? ""} → ${m.to_addr ?? ""}`.trim() + (m.snippet ? ` · ${String(m.snippet).slice(0, 160)}` : ""),
        at: m.internal_date ?? null,
        service: "gmail",
        link: m.thread_id ? `https://mail.google.com/mail/#all/${m.thread_id}` : null,
      });
    }

    for (const e of await all<Record<string, unknown>>(
      ctx.db,
      "SELECT id, title, start_at, attendees, organizer, link FROM events WHERE attendees LIKE ? OR organizer LIKE ? ORDER BY start_at DESC LIMIT ?",
      like,
      like,
      limit,
    )) {
      entries.push({
        kind: "meeting",
        id: e.id,
        title: e.title || "(untitled meeting)",
        detail: `Organised by ${e.organizer ?? "unknown"}`,
        at: e.start_at ?? null,
        service: "google-calendar",
        link: e.link ?? null,
      });
    }

    for (const m of await fathomForPerson(ctx.db, ids)) {
      entries.push({
        kind: "call",
        id: m.url || m.title,
        title: m.title,
        detail: m.summary.slice(0, 200),
        at: m.endedAt || null,
        service: "fathom",
        link: m.url || null,
      });
    }

    for (const w of await whatsappSnippets(ctx.db, ids.wa_jids, limit)) {
      entries.push({
        kind: "whatsapp",
        id: `${w.at}-${w.text.slice(0, 12)}`,
        title: w.fromMe ? "You" : "Them",
        detail: w.text.slice(0, 200),
        at: w.at ?? null,
        service: "whatsapp",
        link: null,
      });
    }

    entries.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    return { person: { id: person.id, name: person.name || person.email }, timeline: entries.slice(0, limit) };
  },

  async list_facts(ctx, args) {
    const limit = Math.min(Number(args.limit ?? 50) || 50, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (args.status) {
      clauses.push("status = ?");
      params.push(String(args.status));
    } else {
      clauses.push("status IN ('PROPOSED','APPLIED')");
    }
    if (args.person_id) {
      clauses.push("person_id = ?");
      params.push(Number(args.person_id));
    }
    const rows = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT * FROM person_facts WHERE ${clauses.join(" AND ")} ORDER BY status, updated_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    const personIds = [...new Set(rows.map((r) => Number(r.person_id)))];
    const names = new Map<number, string>();
    if (personIds.length) {
      const placeholders = personIds.map(() => "?").join(",");
      for (const p of await all<{ id: number; name: string; email: string }>(
        ctx.db,
        `SELECT id, name, email FROM people WHERE id IN (${placeholders})`,
        ...personIds,
      )) {
        names.set(p.id, p.name || p.email);
      }
    }
    return {
      facts: rows.map((r) => ({ ...toFact(r), person_name: names.get(Number(r.person_id)) ?? "" })),
    };
  },

  async reconnect_queue(ctx, args) {
    const limit = Math.min(Number(args.limit ?? 25) || 25, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!args.include_suppressed) clauses.push("suppressed = 0");
    if (args.cohort) {
      clauses.push("cohort = ?");
      params.push(String(args.cohort));
    }
    const rows = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT contact_id, name, email, phone, company, lane, stage, cohort, cohort_rank, priority,
              signal, action, conversation_first, conversation_last, conversation_evidence,
              inbound, outbound, draft, draft_status, suppressed, history_links
       FROM reconnect WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"}
       ORDER BY cohort_rank ASC, priority ASC, conversation_last DESC LIMIT ?`,
      ...params,
      limit,
    );
    return {
      queue: rows.map((r) => ({
        ...r,
        suppressed: Boolean(r.suppressed),
        history_links: safeJsonArray(r.history_links),
      })),
    };
  },

  async connection_status(ctx) {
    const rows = await all<Record<string, unknown>>(
      ctx.db,
      "SELECT id, source, label, status, last_sync_at, item_count, detail FROM connections ORDER BY source",
    );
    return { connections: rows };
  },

  async record_fact(ctx, args) {
    const personId = Number(args.person_id);
    const field = String(args.field ?? "").trim();
    const value = String(args.value ?? "").trim();
    const evidence = Array.isArray(args.evidence) ? (args.evidence as Array<{ kind: string; detail?: string }>) : [];
    if (!field || !value) return { error: "field and value are required" };

    const scored = scoreEvidence(evidence);
    if (!scored.band) return { stored: false, reason: "insufficient evidence", score: scored.score };

    const person = await personOr404(ctx.db, personId);
    if (!person) return { error: "person not found" };

    const existing = await first<{ id: number; status: string }>(
      ctx.db,
      "SELECT id, status FROM person_facts WHERE person_id = ? AND field = ? AND value = ?",
      personId,
      field,
      value,
    );
    if (existing?.status === "DISMISSED") return { stored: false, reason: "previously dismissed" };
    if (existing?.status === "APPLIED") return { stored: false, reason: "already applied" };

    const humanFields = safeJsonArray(person.human_fields);
    const applies = scored.band === "VERIFIED" && !humanFields.includes(field);
    const status = applies ? "APPLIED" : "PROPOSED";
    const now = ctx.now;
    const observedAt = String(args.observed_at ?? now);
    const sourceUrl = args.source_url ? String(args.source_url) : null;

    if (existing) {
      await run(
        ctx.db,
        `UPDATE person_facts SET band = ?, score = ?, evidence = ?, rationale = ?, status = ?, source_url = ?, observed_at = ?, updated_at = ? WHERE id = ?`,
        scored.band,
        scored.score,
        JSON.stringify(evidence),
        scored.rationale,
        status,
        sourceUrl,
        observedAt,
        now,
        existing.id,
      );
    } else {
      await run(
        ctx.db,
        `INSERT INTO person_facts (person_id, field, value, band, score, evidence, rationale, status, source_url, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        personId,
        field,
        value,
        scored.band,
        scored.score,
        JSON.stringify(evidence),
        scored.rationale,
        status,
        sourceUrl,
        observedAt,
        now,
        now,
      );
    }

    if (applies && ROW_FIELDS.has(field)) {
      await run(ctx.db, `UPDATE people SET ${field} = ?, updated_at = ? WHERE id = ?`, value, now, personId);
    }

    return {
      stored: true,
      status,
      band: scored.band,
      score: scored.score,
      rationale: scored.rationale,
      reasons: labelsFor(evidence),
    };
  },

  async decide_fact(ctx, args) {
    const factId = Number(args.fact_id);
    const decision = String(args.decision ?? "");
    if (decision !== "accept" && decision !== "dismiss") return { error: "decision must be accept or dismiss" };
    const fact = await first<{ id: number; person_id: number; field: string; value: string; status: string }>(
      ctx.db,
      "SELECT id, person_id, field, value, status FROM person_facts WHERE id = ?",
      factId,
    );
    if (!fact) return { error: "fact not found" };
    if (fact.status !== "PROPOSED") return { error: "fact is already resolved" };

    if (decision === "dismiss") {
      await run(ctx.db, "UPDATE person_facts SET status = 'DISMISSED', updated_at = ? WHERE id = ?", ctx.now, factId);
      return { status: "DISMISSED" };
    }

    await run(ctx.db, "UPDATE person_facts SET status = 'APPLIED', updated_at = ? WHERE id = ?", ctx.now, factId);
    if (ROW_FIELDS.has(fact.field)) {
      const person = await personOr404(ctx.db, fact.person_id);
      const humanFields = person ? safeJsonArray(person.human_fields) : [];
      if (!humanFields.includes(fact.field)) humanFields.push(fact.field);
      await run(
        ctx.db,
        `UPDATE people SET ${fact.field} = ?, human_fields = ?, updated_at = ? WHERE id = ?`,
        fact.value,
        JSON.stringify(humanFields),
        ctx.now,
        fact.person_id,
      );
    }
    return { status: "APPLIED" };
  },

  async log_outreach(ctx, args) {
    const person = await personOr404(ctx.db, Number(args.person_id));
    if (!person) return { error: "person not found" };
    const channel = String(args.channel);
    const body = String(args.body ?? "");
    const res = await run(
      ctx.db,
      `INSERT INTO outreach (person_id, channel, to_addr, subject, body, status, sent_at, followup_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'logged', ?, ?, ?)`,
      person.id,
      channel,
      channel === "email" ? person.email : "",
      String(args.subject ?? ""),
      body,
      ctx.now,
      args.followup_at ? String(args.followup_at) : null,
      ctx.now,
    );
    return { logged: true, id: (res.meta as { last_row_id?: number } | undefined)?.last_row_id ?? null, person: person.name || person.email };
  },

  async propose_outreach(ctx, args) {
    const person = await personOr404(ctx.db, Number(args.person_id));
    if (!person) return { error: "person not found" };
    const payload = {
      person_id: person.id,
      person_name: person.name || person.email,
      channel: String(args.channel),
      subject: String(args.subject ?? ""),
      body: String(args.body ?? ""),
      rationale: String(args.rationale ?? ""),
      proposed_by: ctx.agent?.name ?? "you",
    };
    await run(
      ctx.db,
      "INSERT INTO approvals (kind, payload, status, created_at) VALUES ('outreach', ?, 'pending', ?)",
      JSON.stringify(payload),
      ctx.now,
    );
    return { queued: true, approval_required: true, note: "Queued for human approval. Nothing was sent." };
  },
};
