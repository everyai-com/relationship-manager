"""Composio — the live sources, over Composio's HTTP API.

Uses the API directly rather than the CLI: the CLI on this machine points at a
host that rejects the key, while the API accepts it. Tool execution needs three
things, and getting any of them wrong returns a bare "tool not found", so they
are resolved from the API rather than hard-coded:

  1. the toolkit's version  (`meta.available_versions[0]`)
  2. a connected account id that is ACTIVE
  3. the user id that account belongs to

What Composio has connected decides what can be synced. Nothing here pretends a
source is live when its account is missing or expired — `probe()` says which.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from ..config import Config

BASE = "https://backend.composio.dev/api/v3"

# Which toolkits this connector knows how to read.
WANTED = {
    "fathom": "Fathom calls",
    "gmail": "Gmail",
    "googlecalendar": "Google Calendar",
}


class ComposioError(RuntimeError):
    pass


class Composio:
    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ComposioError("COMPOSIO_API_KEY is not set")
        self.api_key = api_key

    def _call(self, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        request = urllib.request.Request(
            "%s%s" % (BASE, path),
            data=json.dumps(body).encode() if body is not None else None,
            headers={"x-api-key": self.api_key, "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code in (401, 403):
                raise ComposioError("Composio rejected the key (%s)" % error.code) from error
            raise ComposioError("Composio %s failed (%s): %s" % (path, error.code, detail[:200])) from error
        except urllib.error.URLError as error:
            raise ComposioError("could not reach Composio: %s" % error.reason) from error

    # ---- discovery --------------------------------------------------------

    def accounts(self, toolkit: Optional[str] = None, active_only: bool = True) -> List[Dict[str, Any]]:
        payload = self._call("/connected_accounts?limit=100")
        accounts = payload.get("items", [])
        out = []
        for account in accounts:
            slug = (account.get("toolkit") or {}).get("slug", "")
            if toolkit and slug != toolkit:
                continue
            if active_only and account.get("status") != "ACTIVE":
                continue
            out.append(account)
        return out

    def versions(self, toolkit: str) -> List[str]:
        payload = self._call("/toolkits/%s" % toolkit)
        return (payload.get("meta") or {}).get("available_versions") or []

    def connected_toolkits(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for account in self._call("/connected_accounts?limit=100").get("items", []):
            slug = (account.get("toolkit") or {}).get("slug", "?")
            if account.get("status") == "ACTIVE":
                counts[slug] = counts.get(slug, 0) + 1
        return counts

    def execute(
        self,
        slug: str,
        arguments: Dict[str, Any],
        toolkit: str,
        account: Optional[Dict[str, Any]] = None,
        version: Optional[str] = None,
    ) -> Dict[str, Any]:
        account = account or (self.accounts(toolkit) or [None])[0]
        if not account:
            raise ComposioError(
                "No ACTIVE %s account is connected in Composio. Connect one, then re-run." % toolkit
            )
        versions = self.versions(toolkit)
        resolved_version = version or (versions[0] if versions else None)
        if not resolved_version:
            raise ComposioError("Composio exposes no version for toolkit %s" % toolkit)

        payload = self._call(
            "/tools/execute/%s" % slug,
            method="POST",
            body={
                "user_id": account.get("user_id"),
                "connected_account_id": account["id"],
                "version": resolved_version,
                "arguments": arguments,
            },
        )
        data = payload.get("data")
        if data is None:
            raise ComposioError("%s returned no data: %s" % (slug, json.dumps(payload)[:200]))
        return data


# ---------------------------------------------------------------------------
# Fathom
# ---------------------------------------------------------------------------


def fetch_fathom_meetings(config: Config, days: int = 120, max_pages: int = 12) -> List[Dict[str, Any]]:
    """Recorded calls. Summaries need an API-key connection, so on OAuth we take
    what Fathom will give: who, what, when, and the links."""
    import datetime

    client = Composio(config.composio_api_key)
    created_after = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    meetings: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    for _ in range(max_pages):
        arguments: Dict[str, Any] = {"created_after": created_after, "include_action_items": True}
        if cursor:
            arguments["cursor"] = cursor
        data = client.execute("FATHOM_LIST_MEETINGS", arguments, "fathom")
        items = data.get("items") or []
        for item in items:
            recording_id = item.get("recording_id")
            if not recording_id:
                continue
            attendees: List[str] = []
            for invitee in item.get("calendar_invitees") or []:
                if isinstance(invitee, dict):
                    value = invitee.get("email") or invitee.get("name")
                    if value:
                        attendees.append(str(value))
            recorder = item.get("recorded_by")
            if isinstance(recorder, dict) and recorder.get("email"):
                attendees.append(str(recorder["email"]))

            meetings.append(
                {
                    "id": "fathom_%s" % recording_id,
                    "title": str(item.get("title") or item.get("meeting_title") or "(untitled meeting)")[:300],
                    "endedAt": item.get("recording_end_time") or item.get("created_at"),
                    "attendees": attendees[:12],
                    "summary": str(item.get("default_summary") or "")[:4000],
                    "actionItems": [
                        str(action.get("description") if isinstance(action, dict) else action)
                        for action in (item.get("action_items") or [])
                    ][:20],
                    "url": item.get("share_url") or item.get("url") or "",
                }
            )
        cursor = data.get("next_cursor") or ""
        if not cursor:
            break
    return meetings


# ---------------------------------------------------------------------------
# Gmail and Calendar (only when those toolkits are connected)
# ---------------------------------------------------------------------------

GMAIL_TOOL = "GMAIL_FETCH_EMAILS"
CALENDAR_TOOL = "GOOGLECALENDAR_EVENTS_LIST"


def fetch_gmail(config: Config, query: str = "newer_than:3d", max_results: int = 50) -> List[Dict[str, Any]]:
    client = Composio(config.composio_api_key)
    data = client.execute(GMAIL_TOOL, {"query": query, "max_results": max_results}, "gmail")
    rows = data.get("messages") or data.get("items") or []
    messages: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        message_id = str(row.get("messageId") or row.get("id") or row.get("threadId") or "")
        if not message_id:
            continue
        labels = row.get("labelIds") or row.get("labels") or []
        messages.append(
            {
                "id": message_id,
                "service": "gmail",
                "thread_id": row.get("threadId") or message_id,
                "from_addr": row.get("sender") or row.get("from") or "",
                "to_addr": row.get("to") or row.get("recipient") or "",
                "subject": row.get("subject") or "",
                "snippet": str(row.get("snippet") or row.get("preview") or "")[:1000],
                "body_text": str(row.get("messageText") or row.get("body") or "")[:20000],
                "labels": ",".join(labels) if isinstance(labels, list) else str(labels or ""),
                "is_unread": 1 if "UNREAD" in labels else 0,
                "last_from_user": 1 if "SENT" in labels else 0,
                "internal_date": row.get("messageTimestamp") or row.get("internalDate") or row.get("date") or "",
            }
        )
    return messages


def fetch_calendar(config: Config, days_back: int = 14, days_forward: int = 14) -> List[Dict[str, Any]]:
    import datetime

    client = Composio(config.composio_api_key)
    now = datetime.datetime.now(datetime.timezone.utc)
    data = client.execute(
        CALENDAR_TOOL,
        {
            "timeMin": (now - datetime.timedelta(days=days_back)).isoformat(),
            "timeMax": (now + datetime.timedelta(days=days_forward)).isoformat(),
            "maxResults": 250,
        },
        "googlecalendar",
    )
    rows = data.get("items") or data.get("events") or []
    events: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        start = row.get("start") or {}
        end = row.get("end") or {}
        events.append(
            {
                "id": str(row["id"]),
                "service": "google-calendar",
                "title": row.get("summary") or "",
                "start_at": (start.get("dateTime") or start.get("date")) if isinstance(start, dict) else start,
                "end_at": (end.get("dateTime") or end.get("date")) if isinstance(end, dict) else end,
                "is_all_day": 1 if isinstance(start, dict) and start.get("date") else 0,
                "location": row.get("location") or "",
                "organizer": (row.get("organizer") or {}).get("email", "") if isinstance(row.get("organizer"), dict) else "",
                "attendees": ",".join(
                    str(a.get("email", "")) for a in (row.get("attendees") or []) if isinstance(a, dict)
                ),
                "status": row.get("status") or "",
                "link": row.get("htmlLink") or "",
            }
        )
    return events


def probe(config: Config) -> Optional[str]:
    """None when Composio is usable, otherwise one plain sentence saying why not."""
    if not config.composio_api_key:
        return "COMPOSIO_API_KEY is not set"
    try:
        toolkits = Composio(config.composio_api_key).connected_toolkits()
    except ComposioError as error:
        return str(error)
    if not toolkits:
        return "Composio has no connected accounts"
    wanted = ", ".join("%s×%d" % (slug, count) for slug, count in sorted(toolkits.items()) if slug in WANTED)
    return None if wanted else "nothing this connector can read is connected (found: %s)" % ", ".join(sorted(toolkits))
