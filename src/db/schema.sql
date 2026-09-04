-- Mirrors every IndexedDB object store from the original single-file app,
-- so `src/migration/importLegacy.ts` can round-trip the user's existing
-- "Backup all data" zip / manual dump_*.json files with zero field loss.
-- Actual media bytes live on disk (see src-tauri/src/media.rs); every row
-- here just points at them via `media_path`.

CREATE TABLE IF NOT EXISTS templates (
  id           TEXT PRIMARY KEY,      -- was: keyless store, key = template name
  name         TEXT NOT NULL,
  data_json    TEXT NOT NULL,         -- full project snapshot (images meta, captions, positions, timing, colors)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  captions     TEXT,                  -- JSON array
  has_voice    INTEGER DEFAULT 0,
  has_music    INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL,
  media_path   TEXT                   -- rendered mp4 (was videoBlobs store)
);

CREATE TABLE IF NOT EXISTS video_templates (
  id           TEXT PRIMARY KEY,      -- matches videos.id
  template_json TEXT NOT NULL         -- full editor state needed to reopen/re-render this video
);

CREATE TABLE IF NOT EXISTS voiceovers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  transcript   TEXT,
  status       TEXT DEFAULT 'pending', -- pending | transcribed | error
  matched_video_id INTEGER,
  created_at   INTEGER NOT NULL,
  media_path   TEXT                   -- source mp3 (was voiceoverBlobs store)
);

CREATE TABLE IF NOT EXISTS music (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  is_default   INTEGER DEFAULT 0,
  trim_start   REAL DEFAULT 0,
  trim_end     REAL,
  created_at   INTEGER NOT NULL,
  media_path   TEXT                   -- was musicBlobs store
);

CREATE TABLE IF NOT EXISTS batch_packs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL,
  folder_name  TEXT,
  manifest_json TEXT,
  order_idx    INTEGER
);

CREATE TABLE IF NOT EXISTS batch_pack_status (
  id           TEXT PRIMARY KEY,      -- pack id
  batch_id     TEXT NOT NULL,
  stage        TEXT DEFAULT 'queued', -- queued|preparing|good_to_go|no_mp3_match|rendering|done|error
  folder_name  TEXT,
  error        TEXT,
  match_info   TEXT,
  sync_log     TEXT,
  order_idx    INTEGER,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS batch_pack_templates (
  id           TEXT PRIMARY KEY,      -- pack id
  template_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_renders (
  id           TEXT PRIMARY KEY,      -- pack id
  media_path   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batch_pack_status_batch ON batch_pack_status(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_packs_batch ON batch_packs(batch_id);
