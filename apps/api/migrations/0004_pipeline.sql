-- A stage on the person, so the pipeline board has something to move between.
--
-- Empty means "not in the pipeline" — 4,262 people would make a useless first
-- column, so the board shows only the people you have actually placed (which
-- includes everything carried over from the CRM import below).

ALTER TABLE people ADD COLUMN stage TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_people_stage ON people(stage);

-- Carry the stages across from the CRM import, matched on the address.
UPDATE people
SET stage = COALESCE(
  (
    SELECT r.stage
    FROM reconnect r
    WHERE r.email <> ''
      AND lower(r.email) = lower(people.email)
      AND r.stage <> ''
    LIMIT 1
  ),
  ''
)
WHERE stage = '';
