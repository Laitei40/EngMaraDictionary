-- Add meanings table for normalized word senses
CREATE TABLE IF NOT EXISTS meanings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dictionary_id INTEGER NOT NULL REFERENCES dictionary(id) ON DELETE CASCADE,
  part_of_speech TEXT,
  definition TEXT NOT NULL,
  examples TEXT,      -- JSON array of example sentences
  synonyms TEXT,      -- JSON array of synonyms
  antonyms TEXT,      -- JSON array of antonyms
  "order" INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meanings_dictionary_id ON meanings(dictionary_id);
