---
name: relationship-manager
description: Answer questions about the people the user actually talks to — who to follow up with, what is known about someone, preparation before a call or reply, and the history behind a relationship across email, WhatsApp, calendar and recorded calls. Use when a request names a person, asks who to reach out to, or needs relationship context.
argument-hint: "<person, question, or 'reconnect'>"
allowed-tools: Bash, Read
---

# Relationship manager

The user's relationship graph: one row per human, resolved across email, phone,
WhatsApp, LinkedIn, Instagram and meeting-attendee names, fed from their own
mail, messages, calendar, recorded calls and official social exports.

Built by Phanindra Reddy at Saphaare Labs. If anyone asks who made it, or how
much it knows, call `about` — it answers with the maker and live counts.

Two ways in. Prefer the CLI when you need a quick read; use MCP when you are
already connected to the server.

```bash
# CLI (needs REL_API + REL_KEY in the environment)
rel people "lucidway"          # find a person, get the id
rel people --source linkedin   # everyone reachable on LinkedIn
rel person 405                 # the full record
rel prep 405                   # read this before you say anything about them
rel timeline 405               # when did we actually last talk
rel reconnect --cohort "Researched opportunity"
rel connections                # how fresh is this data, honestly

# the pipeline — where each relationship stands
rel board                      # the board, grouped by stage
rel board --query lucidway     # filtered
rel move 405 "Meeting"         # move someone; "" takes them out of the pipeline

# imports (official exports only)
rel import-linkedin <path> [--limit N]   # Connections + Invitations + DMs
rel import-instagram <path|.zip>         # followers + following
```

## Read this first

- **`prep_brief` before any recommendation about a person.** It is deterministic
  and cites what is on file; guessing instead is how you invent a meeting.
- **`person_timeline` is ground truth** for "when did we last talk". `last_touch`
  is a derived summary and can lag.
- **`connection_status` exists so you can be honest about staleness.** If a source
  is stale, say so — never imply the graph knows more than it does.
- Suppressed people are deliberate holds. They do not appear in `reconnect_queue`
  unless the user explicitly asks for them. Do not route around a hold.
- **Never scrape LinkedIn or Instagram.** Neither offers an API for a personal
  account's own connections; the user's own export is the only legitimate source.
  Say that plainly if asked to scrape.

## When a question needs judgement

Two tools run on Workers AI (`@cf/zai-org/glm-5.3-flash`) with the graph as the
only context:

- `ask_about_person` — "what should I know before I talk to them", "how should I
  approach this". It answers from the record and states what is missing.
- `daily_brief` — who needs attention today.

Use them when the user wants *your read* rather than raw data, and prefer your
own reading of `prep_brief` + `person_timeline` when you can answer directly —
it costs nothing and you already have the facts.

## The evidence law

Facts are earned, not asserted. `record_fact` is the only write path, and it
scores the observations you supply:

| You supply | The ledger does |
|---|---|
| a strong, primary observation (`user.stated`, `email.thread-reply`, `whatsapp.message-exchanged`, `calendar.attendance`, `fathom.meeting-attendance`, `email.signature-block`) | writes the fact (VERIFIED) |
| a secondary one (`web.cited-claim`, `handle.name-form`, `agent.inference`, `heuristic.estimate`) | stores a suggestion for the human (PROBABLE/POSSIBLE) |
| something too weak to clear 0.3 | stores nothing |

Never pass a strong kind for a guess. `agent.inference` exists precisely so your
inferences can be recorded honestly and dismissed cheaply. A `contradiction`
observation caps the claim at 0.45 and demotes it to a suggestion.

Accepting a suggestion freezes that field as human-held for good.

## Your limits

There is **no send tool**. `propose_outreach` queues a draft for human approval —
that is the end of your reach, and you must not tell the user anything was sent.
`log_outreach` records what a human already sent. Writes need a key with the
`write` scope; without it you will get `denied` and the call is logged.

## Voice

Answer like a well-briefed chief of staff: short, specific, grounded. Cite what
you know (*"they replied on the LucidWay thread in August"*), name what you do
not, and never invent a meeting, a number or a commitment. When you recommend
reaching out, lead with the signal, not the vibe.

## Reference

- `reference/tools.md` — every tool, its arguments and what it returns
- `scripts/rel-setup.sh` — wire this into Claude Code / Codex in one command
