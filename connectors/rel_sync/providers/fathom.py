"""Fathom — recorded calls, straight from the API.

Needs FATHOM_API_KEY. Meetings only: titles, attendees, summaries and action
items. No transcripts, so nothing here can be mistaken for a quotation.
"""

from __future__ import annotations

import datetime
import json
import urllib.error
import urllib.request
from typing import Any, Dict, List

from ..config import Config

API = "https://api.fathom.ai/external/v1/meetings"


def available(config: Config) -> bool:
    return bool(config.fathom_api_key)


def fetch_meetings(config: Config, days: int = 7, max_meetings: int = 100) -> List[Dict[str, Any]]:
    if not config.fathom_api_key:
        raise RuntimeError("FATHOM_API_KEY is not set")

    created_after = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).isoformat()
    url = "%s?created_after=%s&include_summary=true&include_action_items=true" % (API, created_after)
    request = urllib.request.Request(url, headers={"X-Api-Key": config.fathom_api_key})

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise RuntimeError("Fathom refused the key (%s) — check FATHOM_API_KEY" % error.code) from error
        raise RuntimeError("Fathom request failed (%s)" % error.code) from error
    except urllib.error.URLError as error:
        raise RuntimeError("could not reach Fathom: %s" % error.reason) from error

    items = payload.get("items") or payload.get("meetings") or []
    meetings: List[Dict[str, Any]] = []
    for item in items[:max_meetings]:
        attendees = []
        for attendee in item.get("meeting_attendees") or item.get("attendees") or []:
            if isinstance(attendee, dict):
                email = attendee.get("email") or attendee.get("email_address")
                name = attendee.get("name") or attendee.get("display_name")
                if email or name:
                    attendees.append(email or name)
            elif attendee:
                attendees.append(str(attendee))

        action_items = []
        for action in item.get("action_items") or []:
            if isinstance(action, dict):
                action_items.append(action.get("description") or action.get("text") or "")
            else:
                action_items.append(str(action))

        meetings.append(
            {
                "id": "fathom_%s" % (item.get("recording_id") or item.get("id")),
                "title": str(item.get("meeting_title") or item.get("title") or "")[:300],
                "endedAt": item.get("meeting_end_time") or item.get("ended_at") or item.get("created_at"),
                "attendees": [value for value in attendees if value][:12],
                "summary": str(item.get("default_summary") or item.get("summary") or "")[:4000],
                "actionItems": [value for value in action_items if value][:20],
                "url": item.get("share_url") or item.get("url") or "",
            }
        )
    return meetings
