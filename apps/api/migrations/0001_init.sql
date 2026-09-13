-- Relationship Manager — the graph.
-- One schema for people, what we know about them (with evidence), and the
-- traces of whoever is talking to the graph: humans or agents.

CREATE TABLE IF NOT EXISTS people (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    NOT NULL DEFAULT '',
  name           TEXT    NOT NULL DEFAULT '',
  title          TEXT    NOT NULL DEFAULT '',
  company        TEXT    NOT NULL DEFAULT '',
  company_domain TEXT    NOT NULL DEFAULT '',
  location       TEXT    NOT NULL DEFAULT '',
  human_fields   TEXT    NOT NULL DEFAULT '[]',
  first_seen     TEXT,
  last_touch     TEXT,
  message_count  INTEGER NOT NULL DEFAULT 0,
  meeting_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email ON people(email) WHERE email <> '';
CREATE INDEX IF NOT EXISTS idx_people_last_touch ON people(last_touch DESC);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);

-- The authoritative cross-source index. A person is one row here per handle.
CREATE TABLE IF NOT EXISTS person_identifiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('email', 'phone', 'wa_jid', 'fathom_attendee')),
  value      TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_person_identifiers_person ON person_identifiers(person_id);

-- Facts are earned, never asserted. band/score/rationale come from the ledger.
CREATE TABLE IF NOT EXISTS person_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL,
  field       TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  band        TEXT    NOT NULL,
  score       REAL    NOT NULL DEFAULT 0,
  evidence    TEXT    NOT NULL DEFAULT '[]',
  rationale   TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPLIED', 'DISMISSED')),
  source_url  TEXT,
  observed_at TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE (person_id, field, value)
);
CREATE INDEX IF NOT EXISTS idx_person_facts_person ON person_facts(person_id, status);
CREATE INDEX IF NOT EXISTS idx_person_facts_status ON person_facts(status);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT    NOT NULL,
  service        TEXT    NOT NULL DEFAULT 'gmail',
  thread_id      TEXT,
  from_addr      TEXT,
  to_addr        TEXT,
  subject        TEXT,
  snippet        TEXT,
  body_text      TEXT,
  labels         TEXT    NOT NULL DEFAULT '',
  is_unread      INTEGER NOT NULL DEFAULT 0,
  last_from_user INTEGER NOT NULL DEFAULT 0,
  internal_date  TEXT,
  synced_at      TEXT    NOT NULL,
  PRIMARY KEY (service, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(service, internal_date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_addr);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT    NOT NULL,
  service    TEXT    NOT NULL DEFAULT 'google-calendar',
  title      TEXT,
  start_at   TEXT,
  end_at     TEXT,
  is_all_day INTEGER NOT NULL DEFAULT 0,
  location   TEXT,
  organizer  TEXT,
  attendees  TEXT    NOT NULL DEFAULT '',
  status     TEXT,
  link       TEXT,
  synced_at  TEXT    NOT NULL,
  PRIMARY KEY (service, id)
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at DESC);

-- Recorded calls (Fathom). Stored whole; attendees stay a JSON array.
CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  ended_at     TEXT,
  attendees    TEXT NOT NULL DEFAULT '[]',
  summary      TEXT NOT NULL DEFAULT '',
  action_items TEXT NOT NULL DEFAULT '[]',
  url          TEXT
);
CREATE INDEX IF NOT EXISTS idx_meetings_ended ON meetings(ended_at DESC);

-- The reconnect queue: who is worth a second conversation, and why.
CREATE TABLE IF NOT EXISTS reconnect (
  contact_id            TEXT PRIMARY KEY,
  name                  TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  chat_id               TEXT,
  company               TEXT NOT NULL DEFAULT '',
  lane                  TEXT NOT NULL DEFAULT '',
  stage                 TEXT NOT NULL DEFAULT '',
  cohort                TEXT NOT NULL DEFAULT '',
  cohort_rank           INTEGER NOT NULL DEFAULT 80,
  priority              INTEGER NOT NULL DEFAULT 80,
  signal                TEXT NOT NULL DEFAULT '',
  action                TEXT NOT NULL DEFAULT '',
  conversation_first    TEXT,
  conversation_last     TEXT,
  conversation_evidence TEXT NOT NULL DEFAULT '',
  inbound               INTEGER NOT NULL DEFAULT 0,
  outbound              INTEGER NOT NULL DEFAULT 0,
  draft                 TEXT NOT NULL DEFAULT '',
  draft_status          TEXT NOT NULL DEFAULT '',
  history_links         TEXT NOT NULL DEFAULT '[]',
  suppressed            INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconnect_rank ON reconnect(suppressed, cohort_rank, priority);

-- Outreach is recorded, never sent by an agent.
CREATE TABLE IF NOT EXISTS outreach (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id     INTEGER,
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  to_addr       TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'logged',
  sent_at       TEXT,
  followup_at   TEXT,
  reply_summary TEXT NOT NULL DEFAULT '',
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_followup ON outreach(followup_at);

-- Honest per-source freshness. A stale source says so.
CREATE TABLE IF NOT EXISTS connections (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('connected', 'stale', 'error', 'not_configured')),
  last_sync_at TEXT,
  item_count   INTEGER NOT NULL DEFAULT 0,
  detail       TEXT NOT NULL DEFAULT ''
);

-- Agents: keys with scopes, and every call they make.
CREATE TABLE IF NOT EXISTS agent_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT 'read',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS agent_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key_id INTEGER,
  tool         TEXT NOT NULL,
  args_digest  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'error')),
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_calls_created ON agent_calls(created_at DESC);

-- Anything an agent proposes that a human must approve.
CREATE TABLE IF NOT EXISTS approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS sync_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source    TEXT NOT NULL,
  pushed_at TEXT NOT NULL,
  inserted  INTEGER NOT NULL DEFAULT 0,
  updated   INTEGER NOT NULL DEFAULT 0,
  skipped   INTEGER NOT NULL DEFAULT 0,
  detail    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
