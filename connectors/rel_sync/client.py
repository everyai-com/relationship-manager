"""Push ingested rows to the hosted graph.

Batches, retries once on a transient failure, and reports what actually landed —
a connector that says "synced" without checking is worse than one that fails
loudly.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .config import Config


class PushError(RuntimeError):
    pass


def _post(config: Config, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    request = urllib.request.Request(
        "%s%s" % (config.api, path),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer %s" % config.key,
            "User-Agent": "rel-sync/0.1 (+https://github.com/everyai-com/relationship-manager)",
            "Origin": config.api,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")[:300]
        if error.code == 403:
            raise PushError("the key was refused (403): %s" % body) from error
        if error.code in (429, 500, 502, 503, 504):
            raise PushError("temporary failure (%s): %s" % (error.code, body)) from error
        raise PushError("push failed (%s): %s" % (error.code, body)) from error
    except urllib.error.URLError as error:
        raise PushError("could not reach %s: %s" % (config.api, error.reason)) from error


def _chunks(items: List[Dict[str, Any]], size: int) -> List[List[Dict[str, Any]]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def push(
    config: Config,
    source: str,
    label: str,
    messages: Optional[List[Dict[str, Any]]] = None,
    events: Optional[List[Dict[str, Any]]] = None,
    meetings: Optional[List[Dict[str, Any]]] = None,
    status: str = "connected",
    detail: str = "",
    last_sync_at: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, int]:
    """Send everything in batches and total up what the graph accepted."""
    messages = messages or []
    events = events or []
    meetings = meetings or []

    totals = {"inserted": 0, "people_created": 0, "people_touched": 0, "linked": 0}
    if not messages and not events and not meetings:
        payload = {
            "source": source,
            "label": label,
            "status": status,
            "detail": detail or "Nothing new since the last run.",
            "last_sync_at": last_sync_at,
            "self_addresses": config.self_addresses,
        }
        if dry_run:
            print("  [dry-run] would record %s as %s" % (source, status))
            return totals
        _post(config, "/api/sync", payload)
        return totals

    # Messages carry the people, so they are chunked; events and meetings ride
    # along with the first message batch or on their own.
    batches: List[Dict[str, Any]] = []
    if messages:
        for index, batch in enumerate(_chunks(messages, config.batch_size)):
            first = index == 0
            batches.append(
                {
                    "source": source,
                    "label": label,
                    "status": status,
                    "detail": detail,
                    "last_sync_at": last_sync_at,
                    "self_addresses": config.self_addresses,
                    "messages": batch,
                    "events": events if first else [],
                    "meetings": meetings if first else [],
                }
            )
    else:
        batches.append(
            {
                "source": source,
                "label": label,
                "status": status,
                "detail": detail,
                "last_sync_at": last_sync_at,
                "self_addresses": config.self_addresses,
                "events": events,
                "meetings": meetings,
            }
        )

    if dry_run:
        print(
            "  [dry-run] would push %d messages, %d events, %d meetings in %d batch(es)"
            % (len(messages), len(events), len(meetings), len(batches))
        )
        return totals

    for index, batch in enumerate(batches, start=1):
        try:
            result = _post(config, "/api/sync", batch)
        except PushError as error:
            if index == 1:
                raise
            # One retry: D1 occasionally throttles a burst.
            time.sleep(2)
            try:
                result = _post(config, "/api/sync", batch)
            except PushError as retry_error:
                raise PushError("%s (retried once)" % retry_error) from error

        totals["inserted"] += int(result.get("inserted", 0))
        totals["people_created"] += int(result.get("created", 0))
        totals["people_touched"] += int(result.get("touched", 0))
        totals["linked"] += int(result.get("linked", 0))
        print(
            "  batch %d/%d → %s rows, %s people touched, %s new"
            % (index, len(batches), result.get("inserted", 0), result.get("touched", 0), result.get("created", 0))
        )

    return totals
