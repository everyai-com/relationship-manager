#!/usr/bin/env python3
"""Pull the live relationship data out of the AIOS workspace snapshot.

Reads `reference/relationship-data/live/settings.db` (read-only) plus the JSON
snapshots beside it, and writes `packages/seed/data/live.json` for the TypeScript
seed builder. Nothing is modified in the source workspace.
"""

from __future__ import annotations

import json
import os
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
LIVE = ROOT / "reference" / "relationship-data" / "live"
OUT = ROOT / "packages" / "seed" / "data" / "live.json"


def rows(conn: sqlite3.Connection, sql: str, args: tuple = ()) -> list:
    try:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]
    except sqlite3.Error as exc:
        print("  ! %s (%s)" % (exc, sql[:60]), file=sys.stderr)
        return []


def load_snapshot(name: str):
    path = LIVE / name
    if not path.exists():
        return None
    try:
        with path.open() as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def main() -> int:
    db_path = LIVE / "settings.db"
    if not db_path.exists():
        print("missing %s" % db_path, file=sys.stderr)
        return 1

    conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    conn.row_factory = sqlite3.Row

    messages = rows(
        conn,
        "SELECT id, service, thread_id, from_addr, to_addr, subject, snippet, body_text, labels,"
        " is_unread, last_from_user, internal_date FROM synced_messages ORDER BY internal_date DESC",
    )
    events = rows(
        conn,
        "SELECT id, service, title, start_at, end_at, is_all_day, location, organizer, attendees,"
        " status, link FROM synced_events ORDER BY start_at DESC",
    )
    sync_state = rows(conn, "SELECT service, cursor, last_sync_at, last_error, message_count FROM sync_state")

    # Full message bodies are kept, but bounded: a single 200KB email is not
    # worth shipping into a seed file a human may want to read.
    for m in messages:
        if m.get("body_text"):
            m["body_text"] = str(m["body_text"])[:20000]

    payload = {
        "source_note": "Extracted from the live AIOS workspace snapshot (read-only copy).",
        "messages": messages,
        "events": events,
        "sync_state": sync_state,
        "mail_snapshot": load_snapshot("mail_snapshot.json"),
        "calendar_snapshot": load_snapshot("calendar_snapshot.json"),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as fh:
        json.dump(payload, fh, ensure_ascii=False)

    size = os.path.getsize(OUT) / 1024.0 / 1024.0
    print("wrote %s — messages=%d events=%d (%.1f MB)" % (OUT.relative_to(ROOT), len(messages), len(events), size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
