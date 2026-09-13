"""Configuration for the local connectors.

Everything comes from the environment (or `connectors/.env`), so a connector
never needs to be edited to be pointed at a different deployment.
"""

from __future__ import annotations

import json
import os
import pathlib
from typing import Dict, List, Optional

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE_PATH = REPO_ROOT / "connectors" / ".state.json"
ENV_PATH = REPO_ROOT / "connectors" / ".env"


def _load_env_file() -> None:
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


class Config:
    def __init__(self) -> None:
        _load_env_file()
        self.api = os.environ.get("REL_API", "").rstrip("/")
        self.key = os.environ.get("REL_KEY", "")
        self.aios_workspace = pathlib.Path(
            os.environ.get(
                "AIOS_WORKSPACE",
                os.path.expanduser("~/Library/Application Support/aios-desktop/ai-sales-os"),
            )
        )
        self.fathom_api_key = os.environ.get("FATHOM_API_KEY", "")
        self.composio_api_key = os.environ.get("COMPOSIO_API_KEY", "")
        self.composio_days = int(os.environ.get("COMPOSIO_DAYS", "120"))
        self.batch_size = int(os.environ.get("REL_BATCH", "400"))
        self.self_addresses = self._self_addresses()

    def _self_addresses(self) -> List[str]:
        raw = os.environ.get("SELF_ADDRESSES", "")
        if raw:
            return [value.strip().lower() for value in raw.split(",") if value.strip()]

        # The repo already knows them (kept out of git on purpose).
        local = REPO_ROOT / "packages" / "seed" / "self-addresses.json"
        if local.exists():
            try:
                return [str(value).lower() for value in json.loads(local.read_text())]
            except (ValueError, OSError):
                pass

        # Otherwise read the addresses the AIOS app knows about.
        settings = self.aios_workspace / "data" / "settings.db"
        if settings.exists():
            try:
                import sqlite3

                conn = sqlite3.connect("file:%s?mode=ro" % settings, uri=True)
                rows = conn.execute(
                    "SELECT value FROM settings WHERE key LIKE '%email%' AND value LIKE '%@%'"
                ).fetchall()
                conn.close()
                found = {str(row[0]).strip().lower() for row in rows if "@" in str(row[0])}
                if found:
                    return sorted(found)
            except sqlite3.Error:
                pass
        return []

    def missing(self) -> List[str]:
        problems = []
        if not self.api:
            problems.append("REL_API is not set (the worker URL)")
        if not self.key:
            problems.append("REL_KEY is not set (an agent key with the write scope)")
        return problems

    def load_state(self) -> Dict[str, Dict[str, str]]:
        if not STATE_PATH.exists():
            return {}
        try:
            return json.loads(STATE_PATH.read_text())
        except (ValueError, OSError):
            return {}

    def save_state(self, state: Dict[str, Dict[str, str]]) -> None:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True))

    def cursor(self, source: str) -> Optional[str]:
        return self.load_state().get(source, {}).get("cursor") or None

    def remember(self, source: str, cursor: str, pushed: int) -> None:
        state = self.load_state()
        state[source] = {"cursor": cursor, "pushed": str(pushed), "at": _now()}
        self.save_state(state)


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def summary() -> str:
    """Human-readable: what this machine can actually sync."""
    config = Config()
    lines = [
        "deployment   %s" % (config.api or "(REL_API not set)"),
        "key          %s" % ("rel_…" if config.key else "(REL_KEY not set)"),
        "aios data    %s%s" % (config.aios_workspace, "" if config.aios_workspace.exists() else "  (not found)"),
        "composio key %s" % ("set" if config.composio_api_key else "not set  → fathom/gmail unavailable"),
        "fathom key   %s" % ("set" if config.fathom_api_key else "not set  (optional: direct API instead of Composio)"),
        "self addr.   %s" % (", ".join(config.self_addresses) if config.self_addresses else "(none known — pass SELF_ADDRESSES)"),
    ]
    return "\n".join(lines)
