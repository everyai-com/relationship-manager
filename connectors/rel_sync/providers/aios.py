"""Read the local AIOS workspace.

The desktop app already ingests this person's mail, calendar and calls into one
SQLite file. That file is the most complete local copy of the graph, so it is
the connector that works on this machine with no new credentials at all — and
anything the app syncs later shows up here on the next run.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
from typing import Any, Dict, List, Optional

from ..config import Config

MESSAGE_COLUMNS = (
    "id, service, thread_id, from_addr, to_addr, subject, snippet, body_text, labels,"
    " is_unread, last_from_user, internal_date"
)
EVENT_COLUMNS = "id, service, title, start_at, end_at, is_all_day, location, organizer, attendees, status, link"


def _connect(db_path: pathlib.Path) -> sqlite3.Connection:
    conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def db_path(config: Config) -> pathlib.Path:
    return config.aios_workspace / "data" / "settings.db"


def read_messages(
    config: Config,
    services: List[str],
    since: Optional[str] = None,
    limit: int = 2000,
) -> List[Dict[str, Any]]:
    path = db_path(config)
    if not path.exists():
        return []
    placeholders = ", ".join("?" for _ in services)
    sql = "SELECT %s FROM synced_messages WHERE service IN (%s)" % (MESSAGE_COLUMNS, placeholders)
    args: List[Any] = list(services)
    if since:
        sql += " AND internal_date > ?"
        args.append(since)
    sql += " ORDER BY internal_date ASC LIMIT ?"
    args.append(limit)

    with _connect(path) as conn:
        rows = [dict(row) for row in conn.execute(sql, args)]
    for row in rows:
        # The API stores bodies, but a 200KB email is not worth re-pushing.
        if row.get("body_text"):
            row["body_text"] = str(row["body_text"])[:20000]
    return rows


def read_events(config: Config, since: Optional[str] = None, limit: int = 1000) -> List[Dict[str, Any]]:
    path = db_path(config)
    if not path.exists():
        return []
    sql = "SELECT %s FROM synced_events" % EVENT_COLUMNS
    args: List[Any] = []
    if since:
        sql += " WHERE start_at > ?"
        args.append(since)
    sql += " ORDER BY start_at ASC LIMIT ?"
    args.append(limit)

    with _connect(path) as conn:
        return [dict(row) for row in conn.execute(sql, args)]


def read_fathom_snapshot(config: Config) -> List[Dict[str, Any]]:
    """Recorded calls, when the app has a snapshot. Meetings only, no transcripts."""
    path = config.aios_workspace / "data" / "fathom_snapshot.json"
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
    except (ValueError, OSError):
        return []
    return payload.get("meetings", []) or []


def collect(config: Config, since: Optional[str] = None, limit: int = 2000) -> Dict[str, List[Dict[str, Any]]]:
    """Everything the workspace holds, grouped the way the API expects it."""
    return {
        "gmail": read_messages(config, ["gmail"], since=since, limit=limit),
        "whatsapp": read_messages(config, ["whatsapp:personal", "whatsapp:business"], since=since, limit=limit),
        "calendar": read_events(config, since=since, limit=limit),
        "fathom": read_fathom_snapshot(config),
    }
