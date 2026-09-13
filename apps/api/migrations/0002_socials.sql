-- Socials: a person can now be reachable on LinkedIn and Instagram too.
--
-- SQLite cannot alter a CHECK constraint in place, so the identifier index is
-- rebuilt and the rows copied across. Existing handles are preserved.

CREATE TABLE IF NOT EXISTS person_identifiers_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('email', 'phone', 'wa_jid', 'fathom_attendee', 'linkedin', 'instagram')),
  value      TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE (kind, value)
);

INSERT OR IGNORE INTO person_identifiers_new (id, person_id, kind, value, created_at)
  SELECT id, person_id, kind, value, created_at FROM person_identifiers;

DROP TABLE person_identifiers;

ALTER TABLE person_identifiers_new RENAME TO person_identifiers;

CREATE INDEX IF NOT EXISTS idx_person_identifiers_person ON person_identifiers(person_id);

-- Social messages (LinkedIn DMs) land in the same table as email, keyed by the
-- conversation so a thread stays together.
CREATE INDEX IF NOT EXISTS idx_messages_service ON messages(service, internal_date DESC);
