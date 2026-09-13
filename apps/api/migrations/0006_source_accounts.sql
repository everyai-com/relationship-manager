-- Sources — the accounts behind the graph.
--
-- Composio holds the connections; this holds which of them *this* graph uses.
-- A source may have several accounts (work and personal Gmail, two calendars),
-- each independently enabled, plus one cached managed auth config per toolkit so
-- connecting a second account is a sign-in and not another config.

CREATE TABLE IF NOT EXISTS toolkit_auth_configs (
  toolkit        TEXT PRIMARY KEY,
  auth_config_id TEXT NOT NULL,
  managed        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  toolkit       TEXT    NOT NULL,
  connection_id TEXT    NOT NULL UNIQUE,
  label         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'pending',
  enabled       INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_accounts_toolkit ON source_accounts(toolkit, enabled);
