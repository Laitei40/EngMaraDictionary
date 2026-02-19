-- Add suggestions table for user improvement submissions
CREATE TABLE IF NOT EXISTS suggestions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_word          TEXT    NOT NULL,
  source_lang          TEXT    NOT NULL,
  english_word         TEXT,
  mara_word            TEXT,
  suggested_definition TEXT    NOT NULL,
  suggested_example    TEXT,
  notes                TEXT,
  submitter_name       TEXT,
  submitter_email      TEXT,
  status               TEXT    NOT NULL DEFAULT 'new',
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_created_at ON suggestions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_status     ON suggestions (status);
