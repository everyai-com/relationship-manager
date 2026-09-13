#!/usr/bin/env node
/**
 * End-to-end suite — runs against a real deployment, not a mock.
 *
 *   REL_API=https://<worker> REL_KEY=rel_... REL_PASSWORD=... node tests/e2e.mjs
 *
 * It creates its own test people (search "ZZ E2E") and leaves them behind only
 * if a test fails mid-way; `node tests/e2e.mjs --cleanup` reports what to delete.
 * Everything it asserts is behaviour a user or an agent would depend on.
 */

const API = (process.env.REL_API ?? "").replace(/\/+$/, "");
const KEY = process.env.REL_KEY ?? "";
const PASSWORD = process.env.REL_PASSWORD ?? "";
const EMAIL = process.env.REL_EMAIL ?? "";

if (!API) {
  console.error("REL_API is required (e.g. REL_API=https://your-worker.workers.dev)");
  process.exit(2);
}

const results = [];
let group = "";
const colour = { green: "\u001b[32m", red: "\u001b[31m", dim: "\u001b[2m", bold: "\u001b[1m", reset: "\u001b[0m" };

function section(name) {
  group = name;
  results.push({ kind: "section", name });
}

async function test(name, fn) {
  try {
    const detail = await fn();
    results.push({ kind: "pass", group, name, detail });
  } catch (error) {
    results.push({ kind: "fail", group, name, detail: error instanceof Error ? error.message : String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { method = "GET", body, key = KEY, cookie, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Better Auth rejects a browser-shaped request (undici sends Sec-Fetch-*)
      // that carries no Origin — that is its CSRF guard doing its job. Real
      // browsers always send this, so the test sends it too.
      Origin: API,
      ...(key && key !== "-" ? { Authorization: `Bearer ${key}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

/** Tool call, unwrapped: throws on !ok so assertions read cleanly. */
async function tool(name, args = {}, key = KEY) {
  const response = await request(`/api/tools/${name}`, { method: "POST", body: args, key });
  assert(response.status < 500, `${name} → HTTP ${response.status} (server error)`);
  if (response.json?.ok === false) return { error: response.json.error, status: response.status, raw: response.json };
  return { result: response.json?.result, meta: response.json?.meta, status: response.status };
}

async function toolOk(name, args = {}, key = KEY) {
  const out = await tool(name, args, key);
  assert(!out.error, `${name} failed: ${out.error}`);
  return out.result;
}

async function mcp(method, params, key = KEY, id = 1) {
  const response = await request("/mcp", {
    method: "POST",
    key,
    body: { jsonrpc: "2.0", id, method, params },
    headers: { Accept: "application/json, text/event-stream" },
  });
  return { status: response.status, json: response.json };
}

// ---------------------------------------------------------------------------

section("auth and session");
let sessionCookie = "";

await test("unauthenticated tool call is refused", async () => {
  const response = await request("/api/tools/search_people", { method: "POST", body: {}, key: "-" });
  assert(response.status === 401, `expected 401, got ${response.status}`);
  return "401 with WWW-Authenticate";
});

await test("an unknown account cannot sign in", async () => {
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: "nobody-here@example.com", password: "correct-horse-battery" },
    key: "-",
  });
  assert(response.status >= 400, `expected a rejection, got ${response.status}`);
  return `${response.status} ${response.json?.message ?? ""}`.trim();
});

await test("a wrong password is rejected", async () => {
  assert(EMAIL, "REL_EMAIL not set");
  const response = await request("/api/auth/sign-in/email", { method: "POST", body: { email: EMAIL, password: "definitely-not-it" }, key: "-" });
  assert(response.status >= 400, `expected a rejection, got ${response.status}`);
  return "rejected";
});

await test("real credentials issue a session cookie", async () => {
  assert(EMAIL && PASSWORD, "REL_EMAIL / REL_PASSWORD not set");
  const response = await request("/api/auth/sign-in/email", { method: "POST", body: { email: EMAIL, password: PASSWORD }, key: "-" });
  assert(response.status === 200, `expected 200, got ${response.status} ${response.text.slice(0, 120)}`);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert(/session_token=/.test(cookie), `no session cookie in: ${cookie.slice(0, 120)}`);
  assert(/HttpOnly/i.test(cookie), "cookie is not HttpOnly");
  sessionCookie = cookie.split(";")[0];
  return "HttpOnly session cookie";
});

await test("the session names the account and the build", async () => {
  const response = await request("/api/session", { cookie: sessionCookie, key: "-" });
  const body = response.json;
  assert(body.authed === true, "not authed");
  assert(body.kind === "human", `kind=${body.kind}`);
  assert(body.account?.email === EMAIL, `account ${body.account?.email} != ${EMAIL}`);
  assert((body.signature ?? "").includes("Saphaare Labs"), "signature missing");
  return `${body.account.email} · ${body.signature.split(" · ")[0]}`;
});

await test("a forged session cookie is not accepted", async () => {
  const response = await request("/api/session", { cookie: "better-auth.session_token=totally-made-up.value", key: "-" });
  assert(response.json.authed === false, "a forged cookie was accepted");
});

await test("sign-up is closed to strangers", async () => {
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email: `stranger-${Date.now()}@example.com`, password: "a-long-enough-password", name: "Stranger" },
    key: "-",
  });
  assert(response.status >= 400, `anyone can create an account (status ${response.status})`);
  return `${response.status} ${response.json?.message?.slice(0, 60) ?? ""}`.trim();
});

section("agent keys and scopes");
let readKey = "";
let writeKey = "";
let readKeyId = 0;
let writeKeyId = 0;

await test("a key can be minted and is shown exactly once", async () => {
  const response = await request("/api/agents", { method: "POST", body: { name: "E2E read", scopes: "read" }, cookie: sessionCookie, key: "-" });
  assert(response.json.key?.startsWith("rel_"), "no key returned");
  assert((response.json.note ?? "").length > 0, "no once-only warning");
  readKey = response.json.key;
  return "rel_… (read)";
});

await test("the key list never exposes the secret", async () => {
  const response = await request("/api/agents", { cookie: sessionCookie, key: "-" });
  const listed = response.json.keys.find((k) => k.scopes === "read" && !k.revoked_at);
  assert(listed, "key not listed");
  readKeyId = listed.id;
  assert(!JSON.stringify(response.json).includes(readKey), "the plaintext key is being returned by the list endpoint");
  return "hash only";
});

await test("a read key can read", async () => {
  const result = await toolOk("search_people", { query: "lucidway", limit: 1 }, readKey);
  assert(Array.isArray(result.people), "no people array");
  return `${result.people.length} result(s)`;
});

await test("a read key is denied on a write tool", async () => {
  const out = await tool("record_fact", { person_id: 1, field: "x", value: "y", evidence: [{ kind: "user.stated" }] }, readKey);
  assert(out.status === 403, `expected 403, got ${out.status}`);
  assert(/no write scope/.test(out.error ?? ""), `unexpected error: ${out.error}`);
  return out.error;
});

await test("the denial is written to the call log", async () => {
  const response = await request("/api/agents/calls?limit=50", { cookie: sessionCookie, key: "-" });
  const denied = response.json.calls.find((c) => c.status === "denied");
  assert(denied, "no denied call recorded");
  return `${denied.tool} denied for ${denied.agent_name}`;
});

await test("a write key is minted", async () => {
  const response = await request("/api/agents", { method: "POST", body: { name: "E2E write", scopes: "write" }, cookie: sessionCookie, key: "-" });
  writeKey = response.json.key;
  assert(writeKey?.startsWith("rel_"), "no key");
  const list = await request("/api/agents", { cookie: sessionCookie, key: "-" });
  writeKeyId = list.json.keys.find((k) => k.name === "E2E write").id;
  return "rel_… (read,write)";
});

await test("pause-all denies agents immediately", async () => {
  await request("/api/agents/0/pause", { method: "POST", body: { paused: true }, cookie: sessionCookie, key: "-" });
  const out = await tool("search_people", { query: "lucidway" }, writeKey);
  assert(/paused/.test(out.error ?? ""), `expected a pause denial, got: ${out.error}`);
  return out.error;
});

await test("resume restores access", async () => {
  await request("/api/agents/0/pause", { method: "POST", body: { paused: false }, cookie: sessionCookie, key: "-" });
  const result = await toolOk("search_people", { query: "lucidway", limit: 1 }, writeKey);
  assert(result.people.length > 0, "still denied");
});

section("the graph: reads");
let davidRice = null;

await test("search_people finds a known person", async () => {
  const result = await toolOk("search_people", { query: "lucidway", limit: 5 });
  davidRice = result.people.find((p) => p.name === "David Rice");
  assert(davidRice, "David Rice not found");
  assert(davidRice.identifiers.emails.includes("david.rice@lucidway.ai"), "identifier missing");
  return `${davidRice.id} · ${davidRice.company}`;
});

await test("search_people with no query lists who you talk to most recently", async () => {
  const result = await toolOk("search_people", { limit: 5 });
  assert(result.people.length > 0, "empty");
  const dates = result.people.map((p) => p.last_touch).filter(Boolean);
  assert(dates.length > 0, "no last_touch values");
  const sorted = [...dates].sort().reverse();
  assert(JSON.stringify(dates) === JSON.stringify(sorted), "results are not ordered by recency");
  return `${result.people.length} recent`;
});

await test("no duplicate people share an email", async () => {
  const result = await toolOk("search_people", { query: "david.rice@lucidway.ai", limit: 20 });
  const withEmail = result.people.filter((p) => p.identifiers.emails.includes("david.rice@lucidway.ai"));
  assert(withEmail.length === 1, `the same person appears ${withEmail.length} times`);
  return "1 row per human";
});

await test("no malformed addresses exist in the graph", async () => {
  const result = await toolOk("search_people", { query: "<", limit: 50 });
  const broken = result.people.filter((p) => /[<> ]/.test(p.email));
  assert(broken.length === 0, `malformed: ${broken.map((p) => p.email).join(", ")}`);
  return "clean";
});

await test("get_person returns facts with evidence and reasons", async () => {
  const person = await toolOk("get_person", { person_id: davidRice.id });
  assert(person.person.name === "David Rice", "wrong person");
  assert(Array.isArray(person.facts), "no facts");
  assert(Array.isArray(person.messages), "no messages");
  const withEvidence = person.facts.filter((f) => f.evidence.length > 0);
  assert(withEvidence.length > 0, "no fact carries evidence");
  return `${person.facts.length} facts, ${person.messages.length} messages`;
});

await test("get_person rejects an unknown id", async () => {
  const out = await tool("get_person", { person_id: 99999999 });
  assert(/not found/.test(out.error ?? ""), `unexpected: ${out.error}`);
});

await test("prep_brief is grounded markdown", async () => {
  const { brief } = await toolOk("prep_brief", { person_id: davidRice.id });
  assert(brief.startsWith("# Prep:"), "no prep heading");
  assert(brief.includes("LucidWay"), "company missing from the brief");
  return brief.split("\n").find((l) => l.startsWith("## ")) ?? "brief";
});

await test("person_timeline is ordered newest first", async () => {
  const { timeline } = await toolOk("person_timeline", { person_id: davidRice.id, limit: 20 });
  assert(timeline.length > 0, "empty timeline");
  const dates = timeline.map((t) => t.at ?? "");
  const sorted = [...dates].sort().reverse();
  assert(JSON.stringify(dates) === JSON.stringify(sorted), "not sorted");
  return `${timeline.length} entries (${[...new Set(timeline.map((t) => t.kind))].join(", ")})`;
});

await test("list_facts defaults to both settled and proposed", async () => {
  const { facts } = await toolOk("list_facts", { limit: 5 });
  assert(facts.length > 0, "empty");
  assert(facts.every((f) => f.person_name !== undefined), "no person_name joined");
  return `${facts.length} facts`;
});

await test("connection_status is honest about freshness", async () => {
  const { connections } = await toolOk("connection_status");
  assert(connections.length >= 7, `only ${connections.length} sources`);
  const gmail = connections.find((c) => c.id === "gmail");
  assert(gmail.status === "stale", `gmail is ${gmail.status} — it is a snapshot, so it must not claim to be live`);
  assert(gmail.last_sync_at, "no timestamp");
  const ai = connections.find((c) => c.id === "ai");
  assert(ai, "Workers AI row missing");
  assert(/glm-5\.3-flash/.test(ai.detail), "model not named on the card");
  return `${connections.length} sources, ${connections.filter((c) => c.status === "stale").length} stale`;
});

section("reconnect queue");
await test("suppressed people never appear in the queue", async () => {
  const without = await toolOk("reconnect_queue", { limit: 200, include_suppressed: false });
  assert(without.queue.every((r) => !r.suppressed), "a suppressed record leaked into the default queue");

  // Held records sit at the bottom of the ranking, so ask for the hold cohort
  // directly rather than paging past 2,000 live rows.
  const held = await toolOk("reconnect_queue", { cohort: "Excluded", include_suppressed: true, limit: 50 });
  assert(held.queue.length > 0, "the deliberate holds are missing entirely");
  assert(held.queue.every((r) => r.suppressed), "an Excluded cohort row is not marked suppressed");

  const denied = await tool("reconnect_queue", { cohort: "Excluded", include_suppressed: false, limit: 50 });
  assert((denied.result?.queue ?? []).length === 0, "the Excluded cohort appeared without asking for it");
  return `${without.queue.length} active, ${held.queue.length} held back`;
});

await test("queue respects a cohort filter", async () => {
  const { queue } = await toolOk("reconnect_queue", { cohort: "Researched opportunity", limit: 10 });
  assert(queue.length > 0, "no rows");
  assert(queue.every((r) => r.cohort === "Researched opportunity"), "cohort filter leaked");
  return `${queue.length} in cohort`;
});

section("the evidence law");
let probe = null;
// Facts are keyed (person, field, value) and a dismissed value is never offered
// again, so every run writes fresh values — otherwise a second run tests the
// previous run's leftovers instead of the behaviour.
const RUN = Date.now().toString(36).slice(-4);

await test("a test person is created for fact probes", async () => {
  const imported = await toolOk("import_social_export", {
    source: "linkedin",
    label: "E2E probe",
    people: [{ name: "ZZ E2E Probe", linkedin: "https://www.linkedin.com/in/rel-e2e-probe", connected_on: "2026-01-01", evidence_kind: "linkedin.connection" }],
  }, writeKey);
  assert(imported.people_created + imported.people_merged === 1, `unexpected import result ${JSON.stringify(imported)}`);
  const found = await toolOk("search_people", { query: "ZZ E2E Probe", limit: 5 });
  probe = found.people[0];
  assert(probe, "probe person not found after import");
  return `person ${probe.id}`;
});

await test("re-importing merges instead of forking", async () => {
  const again = await toolOk("import_social_export", {
    source: "linkedin",
    people: [{ name: "ZZ E2E Probe", linkedin: "https://www.linkedin.com/in/rel-e2e-probe", evidence_kind: "linkedin.connection" }],
  }, writeKey);
  assert(again.people_created === 0, `created ${again.people_created} duplicate people on re-import`);
  assert(again.people_merged === 1, "did not merge into the existing person");
  const found = await toolOk("search_people", { query: "rel-e2e-probe", limit: 5 });
  assert(found.people.length === 1, `handle search returned ${found.people.length} people`);
  return "handles resolve to one row";
});

await test("weak evidence is not stored at all", async () => {
  const out = await tool("record_fact", { person_id: probe.id, field: `seniority_${RUN}`, value: "probably senior", evidence: [{ kind: "agent.inference" }] }, writeKey);
  assert(out.result?.stored === false, "a guess was stored");
  assert(out.result.reason === "insufficient evidence", `reason: ${out.result.reason}`);
  return `score ${out.result.score} → nothing kept`;
});

await test("medium evidence becomes a suggestion, never a claim", async () => {
  const out = await tool("record_fact", { person_id: probe.id, field: "role", value: `Advisor-${RUN}`, evidence: [{ kind: "web.cited-claim", detail: "their site says so" }] }, writeKey);
  assert(out.result?.stored === true, `not stored (${out.error ?? out.result?.reason})`);
  assert(out.result.status === "PROPOSED", `status ${out.result.status}`);
  assert(out.result.band === "POSSIBLE", `band ${out.result.band}`);
  return `${out.result.band} → PROPOSED`;
});

await test("strong evidence is applied and written to the record", async () => {
  const value = `E2E-${RUN}`;
  const out = await tool("record_fact", { person_id: probe.id, field: "location", value, evidence: [{ kind: "user.stated", detail: "you said so" }] }, writeKey);
  assert(out.result?.status === "APPLIED", `status ${out.result?.status ?? out.error}`);
  const person = await toolOk("get_person", { person_id: probe.id });
  assert(person.person.location === value, `the value was not written to the person row (${person.person.location})`);
  return "VERIFIED → applied";
});

await test("the same fact is not recorded twice", async () => {
  const out = await tool("record_fact", { person_id: probe.id, field: "location", value: `E2E-${RUN}`, evidence: [{ kind: "user.stated" }] }, writeKey);
  assert(out.result?.stored === false, "duplicate stored");
  assert(out.result.reason === "already applied", `reason: ${out.result.reason}`);
});

await test("a human decision freezes the field", async () => {
  const { facts } = await toolOk("list_facts", { person_id: probe.id, status: "PROPOSED", limit: 20 });
  const suggestion = facts.find((f) => f.field === "role" && f.value === `Advisor-${RUN}`);
  assert(suggestion, "no proposal to decide");
  const decided = await toolOk("decide_fact", { fact_id: suggestion.id, decision: "accept" });
  assert(decided.status === "APPLIED", `status ${decided.status}`);
  const person = await toolOk("get_person", { person_id: probe.id });
  assert(person.person.human_fields.includes("role"), "the field was not frozen as human-held");
  const override = await tool("record_fact", { person_id: probe.id, field: "role", value: `CTO-${RUN}`, evidence: [{ kind: "user.stated" }] }, writeKey);
  assert(override.result?.status === "PROPOSED", "an agent overwrote a field the human had settled");
  return "accepted → frozen against agents";
});

await test("a dismissed fact is never suggested again", async () => {
  const value = `Robotics-${RUN}`;
  await tool("record_fact", { person_id: probe.id, field: "industry", value, evidence: [{ kind: "web.cited-claim" }] }, writeKey);
  const { facts } = await toolOk("list_facts", { person_id: probe.id, status: "PROPOSED", limit: 50 });
  const target = facts.find((f) => f.field === "industry" && f.value === value);
  assert(target, "proposal missing");
  await toolOk("decide_fact", { fact_id: target.id, decision: "dismiss" });
  const again = await tool("record_fact", { person_id: probe.id, field: "industry", value, evidence: [{ kind: "user.stated" }] }, writeKey);
  assert(again.result?.stored === false, "a dismissed suggestion came back");
  assert(again.result.reason === "previously dismissed", `reason: ${again.result.reason}`);
  return "stays dismissed";
});

await test("a resolved fact cannot be re-decided", async () => {
  const { facts } = await toolOk("list_facts", { person_id: probe.id, status: "PROPOSED", limit: 20 });
  if (facts.length === 0) return "nothing pending (ok)";
  const out = await tool("decide_fact", { fact_id: facts[0].id, decision: "accept" }, writeKey);
  const second = await tool("decide_fact", { fact_id: facts[0].id, decision: "dismiss" }, writeKey);
  assert(second.error === "fact is already resolved", `unexpected: ${second.error}`);
  return "guarded";
});

section("the pipeline board");
await test("a person can be moved into a stage", async () => {
  const out = await toolOk("set_person_stage", { person_id: probe.id, stage: "Meeting" }, writeKey);
  assert(out.stage === "Meeting", `stage is ${out.stage}`);
  assert(/Moved to Meeting/.test(out.note), `note: ${out.note}`);
  return out.note;
});

await test("the board shows them in that column", async () => {
  const board = await toolOk("pipeline_board", { per_stage: 100 });
  const column = board.stages.find((stage) => stage.stage === "Meeting");
  assert(column, "no Meeting column");
  assert(column.people.some((person) => person.id === probe.id), "the moved person is not on the board");
  assert(column.total >= 1, `column total is ${column.total}`);
  return `Meeting: ${column.total} people`;
});

await test("the stage filter finds them", async () => {
  const { people } = await toolOk("search_people", { query: "ZZ E2E Probe", stage: "Meeting", limit: 5 });
  assert(people.some((person) => person.id === probe.id), "stage filter missed them");
  const other = await toolOk("search_people", { query: "ZZ E2E Probe", stage: "Won", limit: 5 });
  assert(!other.people.some((person) => person.id === probe.id), "they appear in a stage they are not in");
});

await test("an unknown stage is refused", async () => {
  const out = await tool("set_person_stage", { person_id: probe.id, stage: "Definitely not a stage" }, writeKey);
  assert(/unknown stage/.test(out.error ?? ""), `unexpected: ${out.error}`);
  const person = await toolOk("get_person", { person_id: probe.id });
  assert(person.person.stage === "Meeting", "a refused move changed the stage anyway");
  return "rejected, stage unchanged";
});

await test("taking someone out of the pipeline works", async () => {
  const out = await toolOk("set_person_stage", { person_id: probe.id, stage: "" }, writeKey);
  assert(out.stage === null, "stage not cleared");
  const board = await toolOk("pipeline_board", { per_stage: 100 });
  const everywhere = board.stages.flatMap((stage) => stage.people.map((person) => person.id));
  assert(!everywhere.includes(probe.id), "they are still on the board after being removed");
  return "removed";
});

await test("moving someone needs the write scope", async () => {
  const out = await tool("set_person_stage", { person_id: probe.id, stage: "Ready" }, readKey);
  assert(out.status === 403, `expected 403, got ${out.status}`);
  return out.error;
});

section("outreach is recorded, never sent");
await test("log_outreach records an attempt with a review date", async () => {
  const out = await toolOk("log_outreach", { person_id: probe.id, channel: "email", subject: "E2E check-in", body: "hello", followup_at: "2026-09-20" }, writeKey);
  assert(out.logged === true, "not logged");
  return `logged #${out.id}`;
});

await test("propose_outreach queues for a human and says nothing was sent", async () => {
  const out = await toolOk("propose_outreach", { person_id: probe.id, channel: "email", subject: "Draft", body: "Draft body", rationale: "E2E" }, writeKey);
  assert(out.queued === true && out.approval_required === true, "not queued for approval");
  assert(/nothing was sent/i.test(out.note ?? ""), "the response does not say nothing was sent");
  const approvals = await request("/api/approvals", { cookie: sessionCookie, key: "-" });
  const pending = approvals.json.approvals.find((a) => a.payload?.person_id === probe.id);
  assert(pending, "the draft is not in the approval queue");
  await request(`/api/approvals/${pending.id}`, { method: "POST", body: { decision: "deny" }, cookie: sessionCookie, key: "-" });
  const after = await request("/api/approvals", { cookie: sessionCookie, key: "-" });
  assert(!after.json.approvals.some((a) => a.id === pending.id), "the denied draft is still pending");
  return "queued → human denied it";
});

await test("there is no tool that can send anything", async () => {
  const { tools } = await request("/api/tools", { cookie: sessionCookie, key: "-" }).then((r) => r.json);
  const senders = tools.filter((t) => /send|email_send|message_send|post_to/i.test(t.name));
  assert(senders.length === 0, `a sending tool exists: ${senders.map((t) => t.name).join(", ")}`);
  return `${tools.length} tools, none can send`;
});

section("socials (LinkedIn)");
await test("LinkedIn people are reachable by source filter", async () => {
  const { people } = await toolOk("search_people", { source: "linkedin", limit: 20 });
  assert(people.length > 0, "no LinkedIn people");
  assert(people.every((p) => p.identifiers.linkedin.length > 0), "a person without a LinkedIn handle was returned");
  return `${people.length} people with handles`;
});

await test("a handle resolves to exactly one person", async () => {
  const { people } = await toolOk("search_people", { query: "linkedin.com/in/", limit: 5 });
  assert(people.length > 0, "handle search found nothing");
  return "handle searchable";
});

await test("LinkedIn connections arrive as suggestions with LinkedIn evidence", async () => {
  const { facts } = await toolOk("list_facts", { status: "PROPOSED", limit: 100 });
  const fromLinkedIn = facts.filter((f) => f.evidence.some((e) => e.kind === "linkedin.connection"));
  assert(fromLinkedIn.length > 0, "no LinkedIn-derived suggestions");
  const sample = fromLinkedIn[0];
  assert(/connected on LinkedIn/i.test(sample.rationale), `rationale: ${sample.rationale}`);
  return `${fromLinkedIn.length} suggestions, e.g. "${sample.field}: ${sample.value}"`;
});

await test("a person with no address does not inherit the mailbox", async () => {
  const { people } = await toolOk("search_people", { source: "linkedin", limit: 60 });
  const noEmail = people.find((p) => !p.email);
  assert(noEmail, "no address-less person to check");
  const { timeline } = await toolOk("person_timeline", { person_id: noEmail.id, limit: 100 });
  const borrowed = timeline.filter((t) => t.kind === "email" || t.kind === "meeting");
  assert(
    borrowed.length === 0,
    `${noEmail.name || noEmail.id} has ${borrowed.length} entries from someone else's mail (empty address matched everything)`,
  );
  const person = await toolOk("get_person", { person_id: noEmail.id });
  assert(person.messages.length === 0, `get_person leaked ${person.messages.length} unrelated messages`);
  return `${noEmail.name || noEmail.id}: no borrowed history`;
});

await test("LinkedIn DMs are in the timeline", async () => {
  const { people } = await toolOk("search_people", { source: "linkedin", limit: 50 });
  let found = null;
  for (const person of people) {
    // A wide window on purpose: the newest-first slice can legitimately push
    // older DMs out of a short timeline for someone with recent meetings.
    const { timeline } = await toolOk("person_timeline", { person_id: person.id, limit: 200 });
    if (timeline.some((t) => t.kind === "linkedin")) {
      found = { person, timeline };
      break;
    }
  }
  assert(found, "no LinkedIn messages appear in any timeline");
  const messages = found.timeline.filter((t) => t.kind === "linkedin");
  return `${found.person.name || found.person.email}: ${messages.length} DM(s), newest "${String(messages[0].detail).slice(0, 50)}"`;
});

await test("prep_brief includes the LinkedIn section", async () => {
  const { people } = await toolOk("search_people", { source: "linkedin", limit: 50 });
  for (const person of people.slice(0, 10)) {
    const { brief } = await toolOk("prep_brief", { person_id: person.id });
    if (brief.includes("## LinkedIn")) return `${person.name || person.email} has a LinkedIn section`;
  }
  throw new Error("no brief mentions LinkedIn");
});

await test("the LinkedIn connection card is honest about no live sync", async () => {
  const { connections } = await toolOk("connection_status");
  const linkedin = connections.find((c) => c.id === "linkedin");
  assert(linkedin, "no LinkedIn card");
  assert(/no live sync is possible|exporting again/i.test(linkedin.detail), `detail: ${linkedin.detail}`);
  assert(linkedin.item_count > 1000, `only ${linkedin.item_count} items — the import looks empty`);
  return `${linkedin.item_count} items, status ${linkedin.status}`;
});

section("Workers AI");
await test("ask_about_person answers from the record", async () => {
  const out = await toolOk("ask_about_person", { person_id: davidRice.id, question: "What is the next step with this person?" }, writeKey);
  assert(out.answer && out.answer.length > 20, "empty answer");
  assert(out.model.includes("glm-5.3-flash"), `model ${out.model}`);
  assert(out.grounded_on.facts >= 0, "no grounding metadata");
  return `${out.answer.length} chars from ${out.grounded_on.facts} facts / ${out.grounded_on.messages} messages`;
});

await test("the model does not answer from thin air", async () => {
  const { people } = await toolOk("search_people", { query: "ZZ E2E Probe", limit: 1 });
  assert(people.length === 1, "probe person missing");
  const answer = await toolOk("ask_about_person", { person_id: people[0].id, question: "What is their favourite film?" }, writeKey);
  assert(
    /no |not |unknown|doesn't|does not|can't|cannot|missing|record/i.test(answer.answer),
    `the model invented something: ${answer.answer.slice(0, 160)}`,
  );
  return `refused to invent: "${answer.answer.slice(0, 70)}…"`;
});

await test("daily_brief is grounded in real counts", async () => {
  const out = await toolOk("daily_brief", {}, writeKey);
  assert(out.brief && out.brief.length > 40, "empty brief");
  assert(out.grounded_on.awaiting_decision > 0, "no proposals counted");
  return `${out.grounded_on.overdue} overdue, ${out.grounded_on.awaiting_decision} awaiting, ${out.grounded_on.reconnect} in queue`;
});

await test("about names the maker and the graph", async () => {
  const out = await toolOk("about", {});
  assert(/Saphaare Labs/.test(out.built_by), "no signature");
  assert(out.author === "Phanindra Reddy", "no author");
  assert(out.graph.people > 100, `only ${out.graph.people} people`);
  assert(out.model.includes("glm"), "model not reported");
  return `${out.built_by} · ${out.graph.people} people · ${out.graph.linkedin} linkedin`;
});

section("MCP protocol");
await test("initialize advertises the server and its maker", async () => {
  const { json } = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert(json.result.serverInfo.name === "relationship-manager", "wrong server name");
  assert(/Saphaare Labs/.test(json.result.instructions ?? ""), "the signature is not in the instructions");
  return `${json.result.serverInfo.name} ${json.result.serverInfo.version}`;
});

await test("tools/list matches the REST catalogue", async () => {
  const { json } = await mcp("tools/list", {});
  const mcpTools = json.result.tools.map((t) => t.name).sort();
  const restTools = (await request("/api/tools", { cookie: sessionCookie, key: "-" }).then((r) => r.json)).tools.map((t) => t.name).sort();
  assert(JSON.stringify(mcpTools) === JSON.stringify(restTools), "MCP and REST disagree on the tool list");
  return `${mcpTools.length} tools identical across surfaces`;
});

await test("tools/call returns structured content", async () => {
  const { json } = await mcp("tools/call", { name: "search_people", arguments: { query: "lucidway", limit: 1 } });
  const payload = JSON.parse(json.result.content[0].text);
  assert(payload.ok === true, "not ok");
  assert(payload.people.length === 1, "wrong result shape");
  return "search_people over MCP";
});

await test("an unknown tool is an error, not a crash", async () => {
  const { json } = await mcp("tools/call", { name: "delete_everything", arguments: {} });
  assert(json.error || json.result?.isError, "unknown tool silently succeeded");
  return "refused";
});

await test("invalid arguments are rejected by schema validation", async () => {
  const { json } = await mcp("tools/call", { name: "get_person", arguments: { person_id: "not-a-number" } });
  const text = json.result?.content?.[0]?.text ?? JSON.stringify(json);
  assert(/invalid input|error/i.test(text), `accepted bad input: ${text.slice(0, 120)}`);
  return "schema enforced";
});

await test("MCP refuses an unauthenticated caller", async () => {
  const { status } = await mcp("tools/list", {}, "-");
  assert(status === 401, `expected 401, got ${status}`);
});

section("web app");
await test("the app shell is served", async () => {
  const response = await request("/", { key: "-" });
  assert(response.status === 200, `status ${response.status}`);
  assert(response.text.includes("Relationship Manager"), "title missing");
  return `${(response.text.length / 1024).toFixed(1)} KB`;
});

await test("an unknown path falls through to the SPA", async () => {
  const response = await request("/people", { key: "-" });
  assert(response.status === 200, `status ${response.status}`);
});

section("cleanup");
await test("test keys are revoked", async () => {
  for (const id of [readKeyId, writeKeyId]) {
    if (id) await request(`/api/agents/${id}/revoke`, { method: "POST", cookie: sessionCookie, key: "-" });
  }
  const list = await request("/api/agents", { cookie: sessionCookie, key: "-" });
  const live = list.json.keys.filter((k) => !k.revoked_at);
  return `${live.length} key(s) still active: ${live.map((k) => k.name).join(", ") || "none"}`;
});

// Last, because it kills the session the tests above need.
await test("signing out invalidates the session", async () => {
  const before = await request("/api/session", { cookie: sessionCookie, key: "-" });
  assert(before.json.authed === true, "not signed in to begin with");
  const out = await request("/api/auth/sign-out", { method: "POST", body: {}, cookie: sessionCookie, key: "-" });
  assert(out.status === 200, `sign-out returned ${out.status}`);
  const after = await request("/api/session", { cookie: sessionCookie, key: "-" });
  assert(after.json.authed === false, "the session still works after signing out");
  return "session cleared";
});

// ---------------------------------------------------------------------------

const failures = results.filter((r) => r.kind === "fail");
const passes = results.filter((r) => r.kind === "pass");

let currentGroup = "";
for (const item of results) {
  if (item.kind === "section") {
    currentGroup = item.name;
    console.log(`\n${colour.bold}${currentGroup}${colour.reset}`);
    continue;
  }
  const mark = item.kind === "pass" ? `${colour.green}✓${colour.reset}` : `${colour.red}✗${colour.reset}`;
  console.log(`  ${mark} ${item.name}${item.detail ? ` ${colour.dim}— ${item.detail}${colour.reset}` : ""}`);
}

console.log(
  `\n${colour.bold}${passes.length} passed, ${failures.length} failed${colour.reset}` +
    (failures.length ? `\n${colour.red}FAILED:${colour.reset} ${failures.map((f) => f.name).join("; ")}` : ""),
);
console.log(
  colour.dim +
    `\nTest data left behind: person "ZZ E2E Probe" (delete with:\n` +
    `  wrangler d1 execute relationship-manager --remote --command "DELETE FROM person_identifiers WHERE value LIKE '%rel-e2e-probe%'; DELETE FROM people WHERE name = 'ZZ E2E Probe'; DELETE FROM person_facts WHERE person_id NOT IN (SELECT id FROM people); DELETE FROM outreach WHERE subject LIKE 'E2E%';")\n` +
    colour.reset,
);

process.exit(failures.length === 0 ? 0 : 1);
