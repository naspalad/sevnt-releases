PRAGMA foreign_keys = ON;

-- SEVNT Studio Core Data Model v1.0
-- Proposed SEVNT schema, informed by the inspected SCL-VSL module boundaries.
-- This is a new implementation; it is not a dump of SCL-VSL's private database.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  workspace_path TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('local_file','remote_url','downloaded_file')),
  original_uri TEXT,
  local_path TEXT,
  filename TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  frame_rate REAL,
  video_codec TEXT,
  audio_codec TEXT,
  probe_json TEXT NOT NULL DEFAULT '{}',
  acquisition_status TEXT NOT NULL DEFAULT 'ready' CHECK (acquisition_status IN ('queued','downloading','probing','ready','failed')),
  checksum_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_project ON media_sources(project_id);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  model_name TEXT,
  language_code TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  full_text TEXT NOT NULL DEFAULT '',
  raw_result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  speaker_id TEXT,
  words_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(transcript_id, segment_index),
  CHECK (start_seconds >= 0 AND end_seconds > start_seconds)
);
CREATE INDEX IF NOT EXISTS idx_segments_time ON transcript_segments(transcript_id, start_seconds);

CREATE TABLE IF NOT EXISTS clip_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  hook_text TEXT NOT NULL DEFAULT '',
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  score REAL,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  topic_key TEXT,
  detection_method TEXT,
  detection_version TEXT,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','selected','dismissed','rendered')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_seconds >= 0 AND end_seconds > start_seconds)
);
CREATE INDEX IF NOT EXISTS idx_candidates_project ON clip_candidates(project_id, status);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES clip_candidates(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'Untitled clip',
  source_start_seconds REAL NOT NULL,
  source_end_seconds REAL NOT NULL,
  output_aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  output_width INTEGER NOT NULL DEFAULT 1080,
  output_height INTEGER NOT NULL DEFAULT 1920,
  edit_state_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','queued','rendering','rendered','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_start_seconds >= 0 AND source_end_seconds > source_start_seconds)
);
CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id, status);

-- Non-destructive keep ranges use clip-relative seconds, matching the SCL-VSL
-- Edit Decision module's documented time axis.
CREATE TABLE IF NOT EXISTS clip_keep_ranges (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  range_index INTEGER NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  UNIQUE(clip_id, range_index),
  CHECK (start_seconds >= 0 AND end_seconds > start_seconds)
);

CREATE TABLE IF NOT EXISTS framing_keyframes (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  time_seconds REAL NOT NULL,
  center_x REAL NOT NULL,
  center_y REAL NOT NULL,
  scale REAL NOT NULL DEFAULT 1,
  rotation_degrees REAL NOT NULL DEFAULT 0,
  target_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','tracking','interpolated')),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(clip_id, time_seconds, target_id)
);
CREATE INDEX IF NOT EXISTS idx_keyframes_clip_time ON framing_keyframes(clip_id, time_seconds);

CREATE TABLE IF NOT EXISTS clip_overlays (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  overlay_type TEXT NOT NULL CHECK (overlay_type IN ('caption','watermark','title','graphic')),
  start_seconds REAL NOT NULL DEFAULT 0,
  end_seconds REAL,
  z_index INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overlays_clip_time ON clip_overlays(clip_id, start_seconds);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','preparing','rendering','validating','completed','failed','cancel_requested','cancelled')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  worker_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  render_settings_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_render_queue ON render_jobs(status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS render_outputs (
  id TEXT PRIMARY KEY,
  render_job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_size_bytes INTEGER,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  checksum_sha256 TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outputs_job ON render_outputs(render_job_id);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project_time ON activity_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  description TEXT NOT NULL
);
