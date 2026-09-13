"""`rel-sync` — keep the hosted graph fresh from this machine.

    rel-sync status          what is connected, and what is missing
    rel-sync aios            push new mail, calendar and calls from the local AIOS workspace
    rel-sync fathom          pull recorded meetings from the Fathom API
    rel-sync composio        pull Gmail and Calendar through Composio
    rel-sync all             everything that is configured

Every push updates the Connections screen, including when a source could not be
reached — the graph is never allowed to imply it is fresher than it is.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any, Dict, List, Optional

from . import config as config_module
from .client import PushError, push
from .config import Config
from .providers import aios, composio, fathom


def _say(message: str) -> None:
    print(message, flush=True)


def _freshness(rows: list) -> tuple:
    """(status, detail) for a batch — a source that stopped producing a week ago
    must not read as live just because we pushed it a minute ago."""
    import datetime

    stamps = []
    for row in rows:
        value = row.get("internal_date") or row.get("start_at") or row.get("endedAt") or ""
        if value:
            stamps.append(str(value))
    if not stamps:
        return "stale", "Nothing dated in this batch."

    newest = max(stamps)
    try:
        when = datetime.datetime.fromisoformat(newest.replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=datetime.timezone.utc)
        age_days = (datetime.datetime.now(datetime.timezone.utc) - when).days
    except ValueError:
        return "stale", "Newest item dated %s." % newest[:10]

    if age_days <= 2:
        return "connected", "Live — newest item %s." % newest[:10]
    return "stale", "Newest item is %s (%d days old) — the source itself has stopped producing." % (
        newest[:10],
        age_days,
    )


def _push_group(config: Config, groups: Dict[str, List[Dict[str, Any]]], dry_run: bool) -> Dict[str, int]:
    totals = {"inserted": 0, "people_created": 0, "people_touched": 0}
    labels = {
        "gmail": "Gmail",
        "whatsapp": "WhatsApp (personal)",
        "calendar": "Google Calendar",
        "fathom": "Fathom calls",
    }

    for source, rows in groups.items():
        if not rows:
            continue
        label = labels.get(source, source)
        status, detail = _freshness(rows)
        _say("\n%s — %d row(s) · %s" % (label, len(rows), status))
        if source == "calendar":
            result = push(config, "google-calendar", label, events=rows, status=status, detail=detail, dry_run=dry_run)
        elif source == "fathom":
            result = push(config, "fathom", label, meetings=rows, status=status, detail=detail, dry_run=dry_run)
        else:
            result = push(config, source, label, messages=rows, status=status, detail=detail, dry_run=dry_run)

        for key, value in result.items():
            totals[key] = totals.get(key, 0) + value
    return totals


def _report(totals: Dict[str, int]) -> None:
    _say(
        "\n%d rows pushed · %d people touched · %d new people"
        % (totals.get("inserted", 0), totals.get("people_touched", 0), totals.get("people_created", 0))
    )
    if totals.get("people_created"):
        _say("New people are on the People screen; their profile fields arrive as suggestions.")


def cmd_status(config: Config, args: argparse.Namespace) -> int:
    _say(config_module.summary())
    _say("")

    state = config.load_state()
    if state:
        _say("cursor (what has already been pushed)")
        for source, entry in sorted(state.items()):
            _say("  %-12s %s  (%s rows)" % (source, entry.get("cursor", "—"), entry.get("pushed", "?")))
    else:
        _say("nothing pushed from this machine yet")

    _say("")
    _say("availability")
    _say("  aios        %s" % ("ready" if aios.db_path(config).exists() else "no workspace database found"))
    _say("  fathom      %s" % ("ready (direct API)" if fathom.available(config) else "needs FATHOM_API_KEY (Composio can serve it instead)"))

    reason = composio.probe(config)
    if reason is None and config.composio_api_key:
        try:
            counts = composio.Composio(config.composio_api_key).connected_toolkits()
            ready = ", ".join("%s×%d" % (slug, count) for slug, count in sorted(counts.items()) if slug in composio.WANTED)
            _say("  composio    ready — %s" % (ready or "nothing readable connected"))
        except composio.ComposioError as error:
            _say("  composio    %s" % error)
    else:
        _say("  composio    %s" % (reason or "COMPOSIO_API_KEY is not set"))
    return 0


def cmd_aios(config: Config, args: argparse.Namespace) -> int:
    since = None if args.full else config.cursor("aios")
    groups = aios.collect(config, since=since, limit=args.limit)
    found = {source: rows for source, rows in groups.items() if rows}
    if not found:
        _say("nothing new in the AIOS workspace%s" % (" since %s" % since if since else ""))
        return 0

    if not args.dry_run:
        _push_group(config, found, dry_run=False)
        newest = max(
            [str(row.get("internal_date") or "") for row in groups["gmail"]]
            + [str(row.get("start_at") or "") for row in groups["calendar"]]
            + [""]
        )
        if newest:
            total = sum(len(rows) for rows in found.values())
            config.remember("aios", newest, total)
    else:
        _push_group(config, found, dry_run=True)
    return 0


def cmd_fathom(config: Config, args: argparse.Namespace) -> int:
    if not fathom.available(config):
        _say("FATHOM_API_KEY is not set — get one from Fathom → Settings → API access, then:")
        _say("  export FATHOM_API_KEY=…    (or put it in connectors/.env)")
        return 2
    meetings = fathom.fetch_meetings(config, days=args.days)
    if not meetings:
        _say("no recorded meetings in the last %d days" % args.days)
        return 0
    _say("Fathom — %d meeting(s)" % len(meetings))
    push(config, "fathom", "Fathom calls", meetings=meetings, detail="Pulled from the Fathom API.", dry_run=args.dry_run)
    return 0


def cmd_composio(config: Config, args: argparse.Namespace) -> int:
    reason = composio.probe(config)
    if reason:
        _say(reason)
        _say("")
        _say("Connect an account in Composio, then re-run. Currently connected:")
        try:
            for slug, count in sorted(composio.Composio(config.composio_api_key).connected_toolkits().items()):
                _say("  %s ×%d" % (slug, count))
        except composio.ComposioError as error:
            _say("  (%s)" % error)
        return 2

    client = composio.Composio(config.composio_api_key)
    toolkits = client.connected_toolkits()

    if args.what in ("fathom", "all") and toolkits.get("fathom"):
        meetings = composio.fetch_fathom_meetings(config, days=args.days)
        if meetings:
            status, detail = _freshness(meetings)
            _say("Fathom (Composio) — %d meeting(s) · %s" % (len(meetings), status))
            push(
                config,
                "fathom",
                "Fathom calls",
                meetings=meetings,
                status=status,
                detail="Live from Fathom through Composio. %s" % detail,
                dry_run=args.dry_run,
            )
        else:
            _say("Fathom: no meetings in the last %d days" % args.days)
    elif args.what in ("fathom", "all"):
        _say("Fathom is not connected in Composio — skipping")

    if args.what in ("gmail", "all"):
        if toolkits.get("gmail"):
            messages = composio.fetch_gmail(config, query=args.query)
            if messages:
                _say("\nGmail (Composio) — %d message(s)" % len(messages))
                push(config, "gmail", "Gmail", messages=messages, detail="Pulled live through Composio.", dry_run=args.dry_run)
            else:
                _say("Gmail: nothing matched %s" % args.query)
        else:
            _say("Gmail is not connected in Composio — skipping (connect it, then re-run)")

    if args.what in ("calendar", "all"):
        if toolkits.get("googlecalendar"):
            events = composio.fetch_calendar(config)
            if events:
                _say("\nGoogle Calendar (Composio) — %d event(s)" % len(events))
                push(config, "google-calendar", "Google Calendar", events=events, detail="Pulled live through Composio.", dry_run=args.dry_run)
            else:
                _say("Calendar: no events in the window")
        else:
            _say("Google Calendar is not connected in Composio — skipping")
    return 0


def cmd_all(config: Config, args: argparse.Namespace) -> int:
    cmd_aios(config, args)
    if config.fathom_api_key:
        cmd_fathom(config, args)
    elif composio.probe(config) is None:
        composio_args = argparse.Namespace(**vars(args))
        composio_args.what = "all"
        cmd_composio(config, composio_args)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rel-sync", description="Keep the relationship graph fresh from this machine.")
    parser.add_argument("--dry-run", action="store_true", help="show what would be pushed, change nothing")
    parser.add_argument("--full", action="store_true", help="ignore the cursor and re-read everything (idempotent)")
    parser.add_argument("--limit", type=int, default=2000, help="max rows to read per source")
    parser.add_argument("--days", type=int, default=7, help="for fathom: how far back to look")
    parser.add_argument("--query", default="newer_than:2d", help="for composio gmail: a Gmail search query")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("status", help="what is connected, and what is missing").set_defaults(func=cmd_status)
    subparsers.add_parser("aios", help="push from the local AIOS workspace").set_defaults(func=cmd_aios)
    subparsers.add_parser("fathom", help="pull recorded meetings from the Fathom API").set_defaults(func=cmd_fathom)

    composio_parser = subparsers.add_parser("composio", help="pull live sources through Composio")
    composio_parser.add_argument("--what", choices=["fathom", "gmail", "calendar", "all"], default="all")
    composio_parser.set_defaults(func=cmd_composio)

    subparsers.add_parser("all", help="everything that is configured").set_defaults(func=cmd_all)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1

    if args.command != "status" and args.dry_run is False:
        config = Config()
        problems = config.missing()
        if problems:
            for problem in problems:
                _say("  %s" % problem)
            return 2
    else:
        config = Config()

    try:
        return int(args.func(config, args) or 0)
    except (PushError, RuntimeError) as error:
        _say("\n%s" % error)
        return 1
    except KeyboardInterrupt:
        _say("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
