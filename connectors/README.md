# connectors — keep the graph fresh from this machine

The hosted app is a snapshot until something feeds it. That something is here.

```bash
cd connectors
cp .env.example .env          # REL_API, REL_KEY, and any source keys

python3 -m rel_sync.cli status            # what is connected, and what is missing
python3 -m rel_sync.cli --dry-run all      # show what would be pushed
python3 -m rel_sync.cli all                # do it
```

Standard library only — no `pip install`, nothing to rot.

## What it can read

| Source | Needs | What lands |
|---|---|---|
| **aios** | the AIOS desktop app on this machine | Gmail, Google Calendar and WhatsApp rows the app already ingested |
| **fathom (Composio)** | `COMPOSIO_API_KEY` with Fathom connected | recorded calls: title, attendees, times, links |
| **fathom (direct)** | `FATHOM_API_KEY` | the same, straight from Fathom |
| **gmail / calendar (Composio)** | the same key, with those toolkits connected | mail and events, live |

`status` is the honest command: it prints what it can reach, what is configured, and
which connected accounts exist — including when a toolkit is *not* connected.

## Freshness is not self-reported

A connector can be told "push this", but it cannot make the card say *connected*.
The API looks at the newest row in the graph for that source and decides:

- newest item ≤ 3 days old → `connected`
- older → `stale`, with the date and the age spelled out
- nothing dated → `not_configured`

That is why a mailbox that stopped syncing eleven days ago reads as stale even
seconds after a successful push. The e2e suite asserts it.

## Idempotent by design

Re-running is always safe:

- a message that is already in the graph is not re-inserted, and — because people
  counts are derived from *new* rows only — it does not inflate anyone's history
- meetings upsert by id
- a cursor in `.state.json` means `aios` only reads what arrived since last time
  (`--full` re-reads everything, which is still safe)

## Composio notes

Composio's API ignores the obvious filter parameters, so tool slugs are invisible
in the catalogue and execution needs three things at once: the toolkit **version**,
a connected-account id that is **ACTIVE**, and that account's **user id**. Get any
of them wrong and the error is a bare "tool not found". This connector resolves all
three from the API at run time rather than hard-coding them.

The CLI on this machine is a separate thing and may be pointed at a different host;
`rel-sync` talks to the API directly and does not depend on it.
