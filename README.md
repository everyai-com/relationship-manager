# relationship-manager

**One graph of the people you actually talk to — and an agent API on top of it.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Demo](https://img.shields.io/badge/demo-2%3A26%20walkthrough-FF5C5C.svg)](https://www.loom.com/share/2bcc0b3f99e24ecb91c35d4a5410aea7)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF.svg)](./AGENTS.md)
[![Tools](https://img.shields.io/badge/tools-17%20from%20one%20contract-6E56CF.svg)](./packages/core/src/tools.ts)
[![Tests](https://img.shields.io/badge/e2e-80%20checks%20against%20production-2E7D32.svg)](./tests/e2e.mjs)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/relationship-manager)

Your relationships are spread across Gmail, WhatsApp, your calendar and recorded calls. Every
tool that tries to "manage" them wants you to type data in — the one thing you will never do.

`relationship-manager` reads the graph you already produced: it resolves the same human across
email, phone, WhatsApp JID and meeting attendee, keeps what it learns as **evidence-backed
facts**, and exposes the whole thing to **agents first** — one remote MCP endpoint, a REST API
and a CLI generated from a single tool contract.

Humans get a calm surface for the two jobs that actually need a human: *deciding what's true*
and *deciding who to reach out to*.

![Ask — a conversation with the graph: a streamed answer, the sources it drew on, and the caveat it volunteered](screenshots/03-ask-answer.png)

*Ask answers from the record, shows what it drew on, and says plainly what the record does not —
including which sources have gone quiet.*

## Demo

[![Watch the walkthrough on Loom — Sync Your Contacts and Conversation Pipelines](./assets/demo-walkthrough.jpg)](https://www.loom.com/share/2bcc0b3f99e24ecb91c35d4a5410aea7)

**Walkthrough (2:26, Loom):** [Sync Your Contacts and Conversation Pipelines](https://www.loom.com/share/2bcc0b3f99e24ecb91c35d4a5410aea7) — click the preview to play.

**Live app:** https://relationship-manager.everyai-com.workers.dev (sign-up is closed after the
owner account — the deployment is one person's real relationships, not a demo tenant).

The demo shows, in one take: sign in → **Ask** answers a question about the graph while
streaming, cites what it drew on and refuses what the record does not say → a profile pinned
into Ask → **Connections** showing which sources are fresh, which have stopped, and every push
that ever landed.

## Screenshots

Every shot below is the real app on a real graph — no mockups, and nothing personal in frame.

**Today — what needs you now.** Live counts, and the sources that have gone quiet, named.

![Today: counts for people, facts to review, reconnect-ready, messages, meetings, agent calls — plus a banner naming the stale sources](screenshots/01-today.png)

**Connections — sign in to your own sources.** One row per toolkit, as many accounts as you like,
each enabled or parked on its own line. The app never sees a password.

![Connections: Add account, Sync now and per-account toggles for Gmail, Google Calendar and Fathom](screenshots/04-connections-accounts.png)

**Connections — freshness you can argue with.** Counts from the rows, the age of the newest one,
and the exact command that refreshes each source locally. Gmail is stale *and says by how much*;
LinkedIn is honest that refreshing means exporting again.

![Source cards with freshness bars, row counts, last-sync pills and copy-ready refresh commands](screenshots/05-connections-freshness.png)

**Ask — starters, not a blank box.** Four questions the graph can actually answer.

![Ask's empty state: what it is grounded on, and four starter questions](screenshots/02-ask.png)

**Agents — one endpoint, every client.** The MCP config for Claude Code, Codex and Cursor, printed
with your URL and the key you just minted.

![The Agents screen: MCP endpoint and copy-ready client configurations](screenshots/06-agents.png)

## Contents

- [What this is](#what-this-is)
- [External apps and services](#external-apps-and-services)
- [Deploy your own (one click)](#deploy-your-own-one-click)
- [Quick start (self-host)](#quick-start-self-host)
- [Connect an agent](#connect-an-agent)
- [MCP reference](#mcp-reference)
- [Tools (the agent surface)](#tools-the-agent-surface)
- [The CLI](#the-cli)
- [REST API](#rest-api)
- [Keeping it fresh](#keeping-it-fresh)
- [Operations](#operations)
- [Architecture](#architecture)
- [Repo layout](#repo-layout)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Safety and privacy](#safety-and-privacy)
- [License](#license)

## What this is

- **Resolves identity across sources.** `person_identifiers` is the authoritative index — email,
  phone, WhatsApp JID, LinkedIn profile, Instagram handle, meeting-attendee name. One human, one
  row, no duplicates invented.
- **Keeps evidence, not vibes.** Every fact carries the observations that produced it and a band
  scored in code: `VERIFIED` (may be written), `PROBABLE` / `POSSIBLE` (offered for your call),
  below that (not stored at all). The model never supplies a confidence number.
- **Prepares you.** `prep_brief` is deterministic and free — who they are, how you're reachable,
  what's on file, recent email, meetings, WhatsApp, recorded calls, LinkedIn.
- **Knows who to reconnect with.** Cohort-ranked, suppression-respecting, with the history it
  was derived from.
- **Answers from the record, not the internet.** `ask_about_person` and `daily_brief` run on
  Workers AI (`@cf/zai-org/glm-5.3-flash`) with the graph as the only context — and say what is
  missing instead of inventing it.
- **Never sends anything.** Agents can propose outreach; a human approves it. Writes are a
  different class of thing.

### The surfaces

- **Today** — what needs you now: facts awaiting a decision, follow-ups that have come due, sources
  that have gone quiet, and what agents did in the last day.
- **Ask** — a conversation with the graph. Answers **stream**, name the people and the trace they
  came from, and carry what they were grounded on (people / facts / sources). Threads are saved;
  open a profile and hit *Ask about them* to pin that person's record to the conversation. It reads
  and only reads — if the record is silent, the answer says so.
- **People** — search, filter by source or pipeline stage, and **expand a profile in place** to see
  what is known, what needs your call, and the last few things that happened. `⌘K` searches from
  anywhere.
- **Pipeline** — a **kanban board** of where each relationship stands. Drag a card to move someone;
  the move is optimistic and rolls back with a message if the write is refused.
- **Profile drawer** — clicking through opens the full record beside the list rather than replacing
  it: overview, history, and the deterministic brief, with the stage selector and the evidence
  behind every value.
- **Reconnect** — the ranked queue with the signal that put each person there; suppressed holds stay
  out unless you ask.
- **Connections** — where the graph came from and how fresh it is, **and the accounts behind it**.
  Sign in to Gmail, Google Calendar and Fathom from the screen — more than one account each, enabled
  or parked independently — then **Sync now** pulls those accounts from the cloud and a daily
  schedule keeps them fresh. Every source carries its real row counts, the age of its newest row,
  and the exact command that refreshes it locally; the push log underneath shows every write that
  ever landed. Freshness is computed from the newest row in the graph, so a source that stopped
  producing reads *stale* with the date — a connector cannot claim otherwise, and a count with no
  rows behind it says so.
- **Agents** — the MCP endpoint, keys, the tool catalogue, the call log and the kill switch.

## External apps and services

Everything this project leans on, and what it is there for. Nothing else is required to run it:
the UI ships with no runtime dependencies beyond React and `lucide-react`, and the connectors are
Python standard library only — no `pip install`, nothing to rot.

| Service | Used for | Where |
|---|---|---|
| **Cloudflare Workers** | the API, the MCP endpoint and the UI, in one Worker | [`wrangler.jsonc`](./wrangler.jsonc), [`apps/api`](./apps/api) |
| **Cloudflare D1** | the relationship graph, accounts, sessions, chat threads | [`apps/api/migrations/`](./apps/api/migrations) |
| **Cloudflare Workers AI** — `@cf/zai-org/glm-5.3-flash` | grounded answers for **Ask**, `ask_about_person`, `daily_brief` | [`apps/api/src/ai.ts`](./apps/api/src/ai.ts) |
| **Cloudflare Cron Triggers** | the daily refresh of connected accounts (`17 13 * * *`) | [`apps/api/src/index.ts`](./apps/api/src/index.ts) `scheduled()` |
| **Composio** | connecting Gmail / Google Calendar / Fathom accounts (OAuth), and pulling them from the cloud | [`apps/api/src/composio.ts`](./apps/api/src/composio.ts), [`connectors/`](./connectors) |
| **Fathom** | recorded calls — attendees, summaries, action items (via Composio or its own API) | `connectors/rel_sync/providers/fathom.py` |
| **Gmail, Google Calendar** | messages and events, read through Composio or the local AIOS workspace | [`apps/api/src/composio.ts`](./apps/api/src/composio.ts), `connectors/rel_sync/providers/aios.py` |
| **WhatsApp** | conversation rows, read from the AIOS desktop app's own database — there is no API for a personal account | `connectors/rel_sync/providers/aios.py` |
| **AIOS desktop app** | the local corpus the connectors read when you would rather not connect a mailbox | `connectors/rel_sync/providers/aios.py` |
| **LinkedIn + Instagram official exports** | connections, invitations and DMs — the only legitimate path, never scraping | `rel import-linkedin`, `rel import-instagram` |
| **Better Auth** | email + password accounts; sessions in D1, HttpOnly cookies | [`apps/api/src/auth-better.ts`](./apps/api/src/auth-better.ts) |
| **MCP clients** — Claude Code, Codex, Cursor, anything MCP | agents reading and acting on the graph through one endpoint | [`apps/api/src/mcp.ts`](./apps/api/src/mcp.ts), [`skill/`](./skill) |

## Deploy your own (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everyai-com/relationship-manager)

The button clones this repository into your GitHub account, provisions the Worker, a D1 database
and the Workers AI binding, applies the schema, and deploys the whole thing — on your account, at
your own `*.workers.dev` URL, with Workers Builds redeploying on every push to your fork.

It asks for exactly one secret: **`BETTER_AUTH_SECRET`** — signs session cookies.
`openssl rand -hex 32`.

**Rather your agent did it?** Hand it the repository and say so. The same deployment is one
idempotent command — it finds or creates the database, generates the session secret, migrates,
builds and deploys — and it will not replace an existing database or rotate a secret that already
works:

```bash
npm run deploy:cloudflare
```

[`AGENTS.md`](./AGENTS.md#if-there-is-no-deployment-yet--host-one-for-them) carries the full
playbook for an agent: check the account, ask before spending it, and tell you honestly that the
graph starts empty.

Then, in order:

1. **Open the app and create the first account.** It becomes the owner, and sign-up closes behind
   you — a fresh deployment is one person's graph, not an open sign-up page.
2. **Point an agent at it.** Open **Agents**, mint a key, and the Claude Code / Codex / Cursor
   configs are printed with your URL *and* the new key already in them. Paste one, ask
   *"who should I reconnect with this week, and why?"*.
3. **Fill the graph** (optional): add `COMPOSIO_API_KEY` under *Settings → Variables and secrets*
   and the **Connections** screen can sign in to Gmail, Google Calendar and Fathom — several
   accounts each — and sync them from the cloud on demand or daily. Without it, the local
   connectors read your own machine instead.

The graph starts empty on purpose — nothing is faked, and every row that arrives carries the
evidence it came from.

## Quick start (self-host)

Runs entirely in your own Cloudflare account. One Worker, one D1 database, one AI binding —
there is no hosted service in the loop and no data leaves your account.

**Prerequisites**

| Requirement | Notes |
|---|---|
| Node | `>= 20` |
| Python | `>= 3.9` — only for the local connectors, standard library, nothing to `pip install` |
| Cloudflare | a free account with Workers, D1 and Workers AI enabled |
| Tools | `npm` (workspaces), `npx wrangler` (installed as a dev dependency) |

```bash
# 1. install
git clone https://github.com/everyai-com/relationship-manager.git
cd relationship-manager
npm install

# 2. local env — copy the template and fill it in
cp .dev.vars.example .dev.vars

# 3. your own database — paste the id it prints into wrangler.jsonc
npm run db:create

# 4. schema: identity, evidence, socials, auth, pipeline, chat
npm run db:migrate

# 5. optional — seed from your own corpora (see Operations below)
npm run seed:build && npm run seed:push

# 6. secrets, then deploy
npx wrangler secret put BETTER_AUTH_SECRET     # openssl rand -hex 32
npx wrangler secret put BETTER_AUTH_URL        # https://<your-worker>.workers.dev
npx wrangler secret put COMPOSIO_API_KEY       # optional — lets the app connect your own accounts
npm run build && npm run deploy
```

Open the deployed app and create the first account — **it becomes the owner**. Sign-up closes
after that; set `ALLOWED_EMAILS` to let specific other people in.

```bash
# optional: let a teammate in
npx wrangler secret put ALLOWED_EMAILS   # "you@example.com, them@example.com"
```

Local development against the real API:

```bash
npx wrangler dev            # the Worker + D1, on http://127.0.0.1:8787
npm run dev                 # the UI on http://localhost:5173, proxies /api and /mcp to 8787
```

> `BETTER_AUTH_URL` is optional: when it is unset the deployment uses the origin the request
> arrived on, so a workers.dev URL — or a dev server on any port — works without configuration.

## Connect an agent

### 1. Mint a key

Open **Agents** in the app → *New key*. Pick `read` or `read,write`. The plaintext `rel_…` key is
shown **once** and stored only as a SHA-256 hash. Or do it over the API:

```bash
curl -X POST https://<your-worker>/api/agents \
  -H "Authorization: Bearer <human session or a write key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"claude-code","scopes":"read,write"}'
```

### 2. Point your client at `/mcp`

**Claude Code**

```bash
claude mcp add --transport http relationship-manager https://<your-worker>/mcp \
  --header "Authorization: Bearer rel_..."
```

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.relationship-manager]
url = "https://<your-worker>/mcp"
http_headers = { Authorization = "Bearer rel_..." }
```

**Cursor, or any JSON MCP config**

```json
{
  "mcpServers": {
    "relationship-manager": {
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer rel_..." }
    }
  }
}
```

**Clients that only speak stdio** (Claude Desktop, older Cursor) — use the local bridge in
`packages/cli/src/mcp-stdio.ts`, which proxies to the remote endpoint:

```json
{
  "mcpServers": {
    "relationship-manager": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/packages/cli/src/mcp-stdio.ts"],
      "env": { "REL_API": "https://<your-worker>", "REL_KEY": "rel_..." }
    }
  }
}
```

**One command for all of the above** — [`skill/relationship-manager/scripts/rel-setup.sh`](./skill/relationship-manager/scripts/rel-setup.sh)
writes the Claude Code and Codex entries for you:

```bash
REL_API=https://<your-worker> REL_KEY=rel_... ./skill/relationship-manager/scripts/rel-setup.sh
```

### 3. Give the agent the skill

`skill/relationship-manager/` teaches an agent **how to use the tools well**, not just how to
call them: read `prep_brief` before recommending anything, prefer `person_timeline` over a
summary, be honest about staleness, respect holds, never scrape a social network, and never claim
something was sent. Drop the folder wherever your client discovers skills, or point the agent at
[`AGENTS.md`](./AGENTS.md) — the same contract in one file.

### 4. Ask it something

> *"Who should I reconnect with this week, and why?"*

The agent calls `reconnect_queue` and `prep_brief`, and every call lands in the **Agents** screen
with its arguments, result and whether it was allowed.

## MCP reference

| Property | Value |
|---|---|
| **Endpoint** | `https://<your-worker>/mcp` — one endpoint, no second server |
| **Transport** | Streamable HTTP, stateless (`sessionIdGenerator: undefined`, JSON responses) |
| **Auth** | `Authorization: Bearer rel_…` agent key — or a signed-in human's session cookie |
| **Scopes** | `read` or `read,write`, per key, enforced server-side |
| **Protocol** | `2025-06-18`; the e2e suite asserts `tools/list` matches the REST catalogue exactly |
| **Surfaces** | tools only — no MCP resources or prompts |
| **Implementation** | [`apps/api/src/mcp.ts`](./apps/api/src/mcp.ts), registered from [`packages/core/src/tools.ts`](./packages/core/src/tools.ts) |
| **stdio bridge** | `npm run rel:mcp` → [`packages/cli/src/mcp-stdio.ts`](./packages/cli/src/mcp-stdio.ts) |

Every request carries its own key, so there is no session state to leak between callers. The
server advertises the evidence law and the no-send rule in its `instructions`, so a client that
reads them starts with the rules.

## Tools (the agent surface)

Seventeen tools, **11 read / 6 write**, defined once in
[`packages/core/src/tools.ts`](./packages/core/src/tools.ts). The MCP server, the REST router and
the CLI all register from that list — the tool you read about is the tool an agent calls.
`GET /api/tools` returns the same catalogue as JSON.

### Read

| Tool | Arguments | What it does |
|---|---|---|
| `search_people` | `query?` `source?` `stage?` `limit?` | Find people by name, email, company, domain or handle. Start here when you don't have a person id. |
| `get_person` | `person_id` | The full record: identity, settled facts with their evidence and reasons, handles, counts. |
| `prep_brief` | `person_id` | Deterministic markdown brief to read before you talk to someone. No model spent. |
| `person_timeline` | `person_id` `limit?` | Merged chronology — email, meetings, calls, WhatsApp. Ground truth for "when did we last talk". |
| `list_facts` | `status?` `person_id?` `limit?` | `PROPOSED` is what awaits a human decision; `APPLIED` is settled. |
| `reconnect_queue` | `cohort?` `limit?` `include_suppressed?` | Ranked reconnect list with cohort, signal and a starter draft. Holds stay hidden unless asked for. |
| `connection_status` | — | Per-source freshness: status, last sync, row count. Call it before implying anything is current. |
| `pipeline_board` | `query?` `per_stage?` | People grouped by the stage you placed them in. Only placed people appear. |
| `ask_about_person` | `person_id` `question?` | Workers AI, grounded on that person's record only — if the record is silent it says so. |
| `daily_brief` | `focus?` | Workers AI brief from overdue follow-ups, undecided facts and the top of the queue. |
| `about` | — | Who built this, and honest live counts of what the graph holds. |

### Write

| Tool | Arguments | What it does |
|---|---|---|
| `record_fact` | `person_id` `field` `value` `evidence[]` `source_url?` | The only path for agent-derived facts. Evidence bands decide what happens. |
| `decide_fact` | `fact_id` `decision` (`accept`\|`dismiss`) | Accept writes the value and freezes the field as human-held; dismiss means it never returns. |
| `set_person_stage` | `person_id` `stage` | Move someone on the board (`""` removes them). Records position; sends nothing. |
| `log_outreach` | `person_id` `channel` `body` `subject?` `followup_at?` | Record an outreach that already happened, and when to review it again. |
| `propose_outreach` | `person_id` `channel` `body` `subject?` `rationale?` | Queue a draft for human approval. The end of an agent's reach. |
| `import_social_export` | `source` `people[]` `messages[]` `self_handles[]` | Official LinkedIn / Instagram exports. Handles merge into existing people; profile fields arrive as suggestions. |

### The evidence law

Facts are not written, they are **earned**. `record_fact` is the only write path, and it scores
the observations the agent supplies — **the model never supplies a confidence number.**

| Band | Score | What happens |
|---|---|---|
| `VERIFIED` | ≥ 0.85 **and** at least one primary observation | written to the record (`APPLIED`) |
| `PROBABLE` | ≥ 0.55 | stored as a suggestion (`PROPOSED`) — the human decides |
| `POSSIBLE` | ≥ 0.3 | stored as a suggestion (`PROPOSED`) |
| below | < 0.3 | **not stored at all** |

`agent.inference` (0.25) and `heuristic.estimate` (0.3) are deliberately weak, so an unsupported
guess cannot clear the bar. A `contradiction` observation caps the score at 0.45 and demotes the
claim to a suggestion. If a human has decided a field, no agent can overwrite it. Weights live in
[`packages/core/src/evidence.ts`](./packages/core/src/evidence.ts).

### Authority, the kill switch and the log

- **Reads are open.** Every key can read.
- **Writes are opt-in per key** and checked in one place — [`apps/api/src/tools/dispatch.ts`](./apps/api/src/tools/dispatch.ts) —
  before anything runs. A read-only key calling a write tool gets `403 denied`, and the denial is
  logged like any other call.
- **The kill switch.** Pausing agents in the UI (`POST /api/agents/0/pause`) rejects every agent
  write immediately, without touching keys.
- **Nothing is sent.** There is no send tool. `propose_outreach` writes a row to `approvals`,
  where a human approves or denies it.
- **Every call is logged** — tool, arguments hash, scope decision, outcome — and shown in the
  Agents screen.

## The CLI

`rel` talks to the same deployment through the same tool contract, which makes it the fastest way
for an agent (or you) to read the graph without an MCP client in the loop.

```bash
export REL_API=https://<your-worker>      # defaults to http://127.0.0.1:8787
export REL_KEY=rel_...

npm run rel -- people "lucidway"          # find a person, get the id
npm run rel -- person 405                 # the full record
npm run rel -- prep 405                   # read this before you say anything about them
npm run rel -- timeline 405               # when did we actually last talk
npm run rel -- reconnect --cohort "Researched opportunity"
npm run rel -- connections                # how fresh is this data, honestly
npm run rel -- facts --status PROPOSED    # what is waiting on your decision
npm run rel -- decide 812 accept
npm run rel -- board --query lucidway
npm run rel -- move 405 "Meeting"
npm run rel -- propose 405 --channel email --body "…" --rationale "…"
```

Import your official exports:

```bash
# LinkedIn → Settings → Data privacy → Get a copy of your data → Connections
npm run rel -- import-linkedin ~/Downloads/Basic_LinkedInDataExport_2026-05-18
npm run rel -- import-linkedin ~/Downloads/Basic_LinkedInDataExport_2026-05-18 --limit 10000   # + recent DMs

# Instagram → Accounts Center → Download your information → Followers and following (JSON)
npm run rel -- import-instagram ~/Downloads/instagram-yourname-2026-09-14.zip
```

- A handle **merges into the existing person** — the same human never forks into two rows, and
  your invitations bring the message you actually wrote.
- A **connection or a DM** is a primary observation (`linkedin.connection` 0.8,
  `linkedin.message-exchanged` 0.85). A **follow** is not (`instagram.you-follow` 0.5), so follows
  arrive as suggestions rather than assertions.
- The Connections screen reports these honestly: imported, never "live" — refreshing means
  exporting again.

**Why exports and not scraping:** LinkedIn has no API for a personal account's own connections,
and Instagram's Graph API is business-only. Scraping either one breaks their terms and risks the
account, so this system takes the only legitimate path.

## REST API

The same tools, over plain HTTP — useful for scripts, and for any agent that speaks HTTP but not
MCP. Authentication is identical: `Authorization: Bearer rel_…`.

```bash
# the catalogue
curl https://<your-worker>/api/tools -H "Authorization: Bearer rel_..."

# any tool, by name — the body is the tool's arguments
curl -X POST https://<your-worker>/api/tools/search_people \
  -H "Authorization: Bearer rel_..." -H "Content-Type: application/json" \
  -d '{"query":"lucidway","limit":5}'

curl -X POST https://<your-worker>/api/tools/record_fact \
  -H "Authorization: Bearer rel_..." -H "Content-Type: application/json" \
  -d '{"person_id":405,"field":"title","value":"Founder","evidence":[{"kind":"user.stated"}]}'
```

Alongside the tool route:

| Route | Purpose |
|---|---|
| `GET /api/session` | who you are, scopes, app name, model |
| `GET /api/overview` | live counts, due outreach, stale sources, recent agent calls |
| `GET/POST /api/agents`, `POST /api/agents/:id/revoke`, `POST /api/agents/0/pause` | keys, revocation, kill switch |
| `GET /api/agents/calls` | the call log |
| `GET /api/approvals`, `POST /api/approvals/:id` | approve or deny proposed outreach |
| `GET /api/connections` | per-source freshness and the push log |
| `GET /api/sources` | the sources you can connect, with every account and which are enabled |
| `POST /api/sources/connect` | start a sign-in for a toolkit (`{"toolkit":"gmail"}`) → `redirect_url` |
| `GET/POST/DELETE /api/sources/accounts/:id` | poll a sign-in, enable/default an account, disconnect it |
| `POST /api/sources/sync` | pull every enabled account of a source (optionally `{"toolkit":"fathom"}`) |
| `GET/POST /api/chat/*` | Ask conversations (streaming) |
| `POST /api/sync` | connector ingestion — facts never travel this path |

There is no OpenAPI file; `GET /api/tools` and the Zod contract are the machine-readable truth.
See [`skill/relationship-manager/reference/tools.md`](./skill/relationship-manager/reference/tools.md)
for every tool's arguments and return shape.

## Keeping it fresh

The hosted app is a snapshot until something feeds it. There are two paths and they land in the
same place — the ingestion route behind `POST /api/sync`, where facts never travel.

### 1. Connect accounts in the app (cloud)

Set `COMPOSIO_API_KEY` as a Worker secret, then on the **Connections** screen press *Add account*
next to Gmail, Google Calendar or Fathom and finish the sign-in in the tab Composio opens. The
account appears as `connected` on its own line; add as many as you like — a work and a personal
mailbox, two calendars — and enable or park each one independently. **Sync now** pulls every
enabled account, and a daily Cron Trigger (`17 13 * * *`) does the same unattended.

- **This app never sees a password.** Composio owns the OAuth flow; all that comes back is an
  account id, and the key never leaves the Worker.
- **Only what you enabled is pulled.** A dashboard full of abandoned connects is listed honestly —
  and ignored until you tick it.
- **Same ingestion, same honesty.** A cloud pull goes through the same `applySync` as the
  connectors, so it is idempotent and it moves the same freshness numbers the screen shows.

### 2. Push from this machine (local connectors)

`connectors/` reads what only exists locally — the AIOS desktop app's own database (mail, calendar,
WhatsApp), or a direct Fathom API key — and pushes it up.

```bash
cd connectors && cp .env.example .env     # REL_API, REL_KEY, and any source keys
python3 -m rel_sync.cli status            # what is connected, and what is missing
python3 -m rel_sync.cli all               # push everything reachable
```

| Source | Needs | What lands |
|---|---|---|
| **aios** | the AIOS desktop app on this machine | Gmail, Google Calendar and WhatsApp rows it already ingested |
| **fathom (Composio)** | `COMPOSIO_API_KEY` with Fathom connected | recorded calls: title, attendees, times, links |
| **fathom (direct)** | `FATHOM_API_KEY` | the same, straight from Fathom |
| **gmail / calendar (Composio)** | the same key, with those toolkits connected | mail and events, live |

- **Freshness is not self-reported.** The API computes it from the newest row in the graph:
  ≤ 3 days is `connected`, older is `stale` with the date, nothing dated is `not_configured`. A
  connector cannot claim otherwise.
- **Idempotent by design.** A message already in the graph is not re-inserted, so re-running an
  unchanged mailbox does not inflate anyone's history.
- Standard library only — no `pip install`, nothing to rot. See [`connectors/README.md`](./connectors/README.md).

## Operations

### Environment variables

| Name | Where | Required | Notes |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | Worker secret | yes | `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Worker secret | yes | canonical origin; must match the deployed URL |
| `ALLOWED_EMAILS` | Worker secret | no | comma-separated; without it only the first account exists |
| `COMPOSIO_API_KEY` | Worker secret | no | lets the app connect Gmail / Google Calendar / Fathom accounts and sync them from the cloud |
| `REL_API` | local / connectors | yes | the deployment to talk to |
| `REL_KEY` | local / connectors | yes | agent key — needs the `write` scope to push |
| `FATHOM_API_KEY`, `COMPOSIO_API_KEY`, `AIOS_WORKSPACE`, `SELF_ADDRESSES` | connectors | no | see [`connectors/.env.example`](./connectors/.env.example) |

`APP_NAME` and `AI_MODEL` are plain vars in [`wrangler.jsonc`](./wrangler.jsonc).

### Database, migrations and seeding

Migrations live in [`apps/api/migrations/`](./apps/api/migrations) (`0001_init` → `0006_source_accounts`)
and run through wrangler's own tracker with `npm run db:migrate` — ordered, recorded, and safe to
re-run. `npm run deploy` applies them first, which is how a one-click deploy initialises its own
database. Seeding is optional and reads **your own** corpora from
`reference/` (gitignored — a fresh clone has none), so most self-hosters skip step 5 and let the
connectors build the graph instead.

```bash
npm run db:create         # once; paste the id into wrangler.jsonc
npm run db:migrate        # schema, socials, auth tables, pipeline, chat
npm run seed:build        # reference/ → packages/seed/out/seed-*.sql
npm run seed:push         # chunked to stay inside D1 request limits
```

The seed **replaces** graph tables (`people`, `messages`, `events`, `meetings`, `person_facts`,
`connections`, `reconnect`) and deliberately leaves runtime tables alone — agent keys, the call
log, approvals and outreach survive a re-seed.

### Testing

```bash
npm test                                  # unit: the evidence ledger and identity resolution
npm run typecheck
REL_API=… REL_KEY=… REL_PASSWORD=… REL_EMAIL=… npm run test:e2e
```

`tests/e2e.mjs` runs **against a real deployment** — no mocks, no staging copy. It covers auth and
session forgery, key scopes (a read key must be denied on every write tool *and* that denial must
reach the call log), the kill switch, the evidence law end to end (weak evidence stores nothing,
medium becomes a suggestion, strong is applied; a human decision freezes the field; a dismissed
value never returns), the reconnect queue's suppression rules, LinkedIn/Instagram imports
(including that a re-import merges rather than forks), the Workers AI tools (including that the
model says *"the record doesn't say"* instead of inventing), the MCP protocol (`tools/list` matches
the REST catalogue exactly), the ask/conversation surface (that it streams, persists and refuses to
invent), source connections (an unknown source is refused, a sign-in starts and can be abandoned
cleanly, an account with no rows behind it is never claimed as synced), and the web shell.

Current state: **80 checks passing, 0 failing** against the production deployment. The suite is
re-runnable — it writes fresh fact values each run, so a second run tests behaviour rather than the
first run's leftovers. It creates one clearly-labelled person (`ZZ E2E Probe`) and prints the SQL
to remove it.

## Architecture

```mermaid
flowchart LR
    subgraph Sources["Sources"]
      G[Gmail]
      W[WhatsApp]
      C[Calendar]
      F[Fathom calls]
      S[LinkedIn / Instagram exports]
    end
    subgraph Local["Local ingest (optional)"]
      L[connectors → POST /api/sync]
    end
    subgraph Edge["Cloudflare Worker"]
      A[apps/api: REST + MCP]
      D[(D1: the relationship graph)]
      U[apps/web: UI]
    end
    subgraph Agents["Agents"]
      M1[Claude Code]
      M2[Codex]
      M3[Anything MCP]
      M4[rel CLI]
    end
    G --> L --> A
    W --> L
    C --> L
    F --> L
    S --> A
    A --- D
    U --- A
    M1 -->|MCP| A
    M2 -->|MCP| A
    M3 -->|MCP| A
    M4 -->|REST| A
```

One definition drives all three surfaces: [`packages/core/src/tools.ts`](./packages/core/src/tools.ts).
The MCP server, the REST router and the CLI register from that list, and every call — whatever
the surface — goes through one dispatch path that validates the input, checks the scope, honours
the kill switch and writes the call log.

## Repo layout

```
apps/api            Cloudflare Worker — REST + remote MCP + auth + D1
apps/web            Vite + React UI (AIOS design tokens, light/dark)
packages/core       evidence ledger, identity resolution, the tool contract (+ tests)
packages/seed       importers: real corpora + live SQLite → migrations/seed.sql
packages/cli        `rel` — talk to the deployed graph from a terminal; stdio MCP bridge
skill/              the agent skill bundle (teaches an agent how to use the tools well)
connectors/         local Python ingest → POST /api/sync
```

## Limitations

Told straight, because a demo that hides these is a worse demo:

- **The graph is only as fresh as its last sync.** Gmail, Google Calendar and Fathom can be pulled
  from the cloud; LinkedIn, Instagram and WhatsApp cannot be live at all — the first two have no
  API for a personal account, and the third is read from the AIOS desktop app on your machine.
  The Connections screen shows each source's real age rather than smoothing it over.
- **WhatsApp needs that local app.** There is no API for a personal WhatsApp account, so that
  source is whatever the AIOS workspace already ingested.
- **Ask is read-only, and slow on purpose.** It cannot draft or send anything; writes go through
  `record_fact` / `propose_outreach` where the evidence law and a human stand in the way. The
  model behind it is a *reasoning* model, so answers take seconds and sometimes longer.
- **One graph per deployment.** The first account becomes the owner and sign-up closes; there are
  no per-user partitions. `ALLOWED_EMAILS` lets specific people in to the *same* graph.
- **Deduplication is heuristic.** The same human across email, phone and socials is usually
  resolved, but a person who appears under two unrelated addresses can still arrive as two rows —
  merge them by hand rather than trusting the heuristic blindly.
- **Freshness is a 3-day rule.** A source that produced rows yesterday and then died still reads
  `connected` for two more days. That is deliberate (it avoids flapping) and it is why the dates
  are always shown.
- **The demo video predates the account-connecting work** — it shows Connections as a health
  screen. The screenshots above are current.

## Roadmap

Not built yet, in the order that would matter most:

- **More toolkits the graph can read** — Outlook, Slack, Notion. `apps/api/src/composio.ts` and
  the account model are already generic; each addition is a catalog entry plus a field mapping.
- **Finer sync control** — per-account schedules and backfill windows, instead of one daily pass
  for everything enabled.
- **A sync you can watch** — the pull runs server-side today and reports counts when it finishes;
  streaming its progress into the Connections screen is the obvious next step.
- **Thread management in Ask** — rename, search across conversations, and share one thread with a
  teammate.
- **Contradiction surfacing** — the evidence ledger already caps contradicted claims; showing the
  conflicting observations side by side in the UI would make them actionable.
- **More official importers** — the social path currently covers LinkedIn and Instagram exports.

## Safety and privacy

- **Accounts, not a shared password.** Better Auth sessions in D1; the first account is the owner
  and sign-up closes after that. Sessions last 30 days, refresh daily, and signing out invalidates
  the session server-side.
- **Humans and agents are different principals.** A human session can do everything; an agent key
  carries explicit scopes, is revocable, and every call is logged.
- **Reads by default, writes opt-in** per key, validated in one place.
- **Facts need evidence.** `score_evidence()` decides the band; below `POSSIBLE` nothing is stored.
- **No sending.** Agents draft and propose; a human approves. Outreach is logged, never fired.
- **Your data never enters this repo.** The graph lives in your own D1 database and in local
  files (`reference/`, generated `packages/seed/out/`) — all gitignored. The repository is the
  engine, the surfaces and the deploy path, and nothing else.

## License

MIT — see [LICENSE](./LICENSE).

---

Built by [Phanindra Reddy](https://github.com/everyai-com) at **Saphaare Labs** · [magicteams.ai](https://magicteams.ai)

**Part of the everyai-com agent stack:** [distillory](https://github.com/everyai-com/distillory) ·
[agent-ready](https://github.com/everyai-com/agent-ready) ·
[agentprofile](https://github.com/everyai-com/agentprofile) ·
[primer](https://github.com/everyai-com/primer) ·
[plainsync](https://github.com/everyai-com/plainsync) ·
[argus](https://github.com/everyai-com/argus)
