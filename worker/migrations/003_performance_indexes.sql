-- ============================================================
-- Migration 003: Performance indexes, FTS5, updated_at, rate limits
-- Targets 100k+ entries with <200ms search latency
-- ============================================================

-- ── 1. Add updated_at to dictionary ──────────────────────────────────
ALTER TABLE dictionary ADD COLUMN updated_at TEXT;
UPDATE dictionary SET updated_at = created_at WHERE updated_at IS NULL;

-- Trigger: stamp updated_at on INSERT (belt-and-suspenders with worker code)
CREATE TRIGGER IF NOT EXISTS trg_dict_insert_updated_at
AFTER INSERT ON dictionary FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE dictionary SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger: auto-refresh updated_at on any column change
CREATE TRIGGER IF NOT EXISTS trg_dict_update_updated_at
AFTER UPDATE OF english_word, mara_word, part_of_speech, definition, example_sentence
ON dictionary FOR EACH ROW
BEGIN
  UPDATE dictionary SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Index for delta-sync query (WHERE updated_at > ?)
CREATE INDEX IF NOT EXISTS idx_dict_updated_at ON dictionary(updated_at);

-- ── 2. FTS5 virtual table ─────────────────────────────────────────────
-- content= keeps FTS in sync with the source table via triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS dictionary_fts USING fts5(
  english_word,
  mara_word,
  definition,
  content='dictionary',
  content_rowid='id'
);

-- Populate/rebuild the FTS index from the content table (idempotent).
-- Works on both initial creation and subsequent re-runs.
INSERT INTO dictionary_fts(dictionary_fts) VALUES('rebuild');

-- Trigger: keep FTS in sync on INSERT
CREATE TRIGGER IF NOT EXISTS trg_fts_after_insert
AFTER INSERT ON dictionary BEGIN
  INSERT INTO dictionary_fts(rowid, english_word, mara_word, definition)
  VALUES (NEW.id, NEW.english_word, COALESCE(NEW.mara_word,''), COALESCE(NEW.definition,''));
END;

-- Trigger: keep FTS in sync on UPDATE (delete + reinsert)
CREATE TRIGGER IF NOT EXISTS trg_fts_after_update
AFTER UPDATE ON dictionary BEGIN
  DELETE FROM dictionary_fts WHERE rowid = OLD.id;
  INSERT INTO dictionary_fts(rowid, english_word, mara_word, definition)
  VALUES (NEW.id, NEW.english_word, COALESCE(NEW.mara_word,''), COALESCE(NEW.definition,''));
END;

-- Trigger: keep FTS in sync on DELETE
CREATE TRIGGER IF NOT EXISTS trg_fts_after_delete
AFTER DELETE ON dictionary BEGIN
  DELETE FROM dictionary_fts WHERE rowid = OLD.id;
END;

-- ── 3. Additional lookup indexes ─────────────────────────────────────
-- Covers browse (LIKE 'a%') and word-level exact lookup with COLLATE NOCASE
CREATE INDEX IF NOT EXISTS idx_dict_part_of_speech ON dictionary(part_of_speech);

-- ── 4. Suggestion status constraint (application-enforced via CHECK) ──
-- SQLite cannot add a CHECK constraint via ALTER TABLE; enforced in worker code.
-- Existing idx_suggestions_status already covers status filter queries.

-- ── 5. Rate-limiting table for POST /api/suggestions ─────────────────
CREATE TABLE IF NOT EXISTS suggestion_rate_limits (
  ip_hash      TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start TEXT    NOT NULL DEFAULT (datetime('now'))
);
