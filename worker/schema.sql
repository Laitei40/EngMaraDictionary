-- ============================================================
-- English ⇄ Mara Dictionary — D1 Schema
-- ============================================================

-- Main dictionary table
CREATE TABLE IF NOT EXISTS dictionary (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  english_word     TEXT    NOT NULL,
  mara_word        TEXT    NOT NULL,
  part_of_speech   TEXT,
  definition       TEXT,
  example_sentence TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for fast case-insensitive lookups
CREATE INDEX IF NOT EXISTS idx_english_word ON dictionary (english_word COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_mara_word    ON dictionary (mara_word COLLATE NOCASE);
