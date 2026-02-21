-- ============================================================
-- Migration 004: Editorial Workflow — Identity, Audit, Revisions, Soft Delete
-- ============================================================

-- ── 1. Admin Users (application-level authorization) ──────────
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','senior_reviewer','reviewer')),
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);

-- ── 2. Audit Logs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id INTEGER,
  performed_by TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_table ON audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

-- ── 3. Extend dictionary table for authority workflow ─────────
-- status: approved or archived (soft delete)
ALTER TABLE dictionary ADD COLUMN status TEXT DEFAULT 'approved';
ALTER TABLE dictionary ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE dictionary ADD COLUMN approved_by TEXT;
ALTER TABLE dictionary ADD COLUMN approved_at DATETIME;
ALTER TABLE dictionary ADD COLUMN updated_by TEXT;

-- Set existing rows to approved
UPDATE dictionary SET status = 'approved' WHERE status IS NULL;
UPDATE dictionary SET version = 1 WHERE version IS NULL;

CREATE INDEX IF NOT EXISTS idx_dict_status ON dictionary(status);

-- ── 4. Word Revisions (pending edits) ────────────────────────
CREATE TABLE IF NOT EXISTS word_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  proposed_english_word TEXT,
  proposed_mara_word TEXT,
  proposed_definition TEXT,
  proposed_example TEXT,
  proposed_part_of_speech TEXT,
  proposed_meanings TEXT,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_by TEXT,
  reviewed_at DATETIME,
  review_note TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  FOREIGN KEY (word_id) REFERENCES dictionary(id)
);

CREATE INDEX IF NOT EXISTS idx_revisions_word_id ON word_revisions(word_id);
CREATE INDEX IF NOT EXISTS idx_revisions_status ON word_revisions(status);
CREATE INDEX IF NOT EXISTS idx_revisions_created_by ON word_revisions(created_by);
