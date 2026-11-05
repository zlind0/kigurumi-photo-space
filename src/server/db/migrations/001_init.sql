CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'uploader', 'viewer')),
  password_lookup TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_login_at   INTEGER,
  disabled        INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  dir_name    TEXT NOT NULL,
  dir_key     TEXT NOT NULL UNIQUE,
  visibility  TEXT NOT NULL DEFAULT 'public'
              CHECK (visibility IN ('public', 'private')),
  created_at  INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_albums_created ON albums(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_albums_visibility ON albums(visibility, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS photos (
  id                INTEGER PRIMARY KEY,
  album_id          INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  md5               TEXT NOT NULL,
  thumb_md5         TEXT NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  size_bytes        INTEGER NOT NULL,
  thumb_size_bytes  INTEGER NOT NULL,
  tier              TEXT NOT NULL DEFAULT 'other'
                    CHECK (tier IN ('cover', 'featured', 'other')),
  visibility        TEXT NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public', 'private')),
  original_name     TEXT,
  mime              TEXT NOT NULL DEFAULT 'image/avif',
  exif_json         TEXT,
  created_at        INTEGER NOT NULL,
  uploaded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  upload_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  deleted_at        INTEGER,
  UNIQUE (album_id, md5)
);
CREATE INDEX IF NOT EXISTS idx_photos_album_created
  ON photos(album_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_album_vis_tier
  ON photos(album_id, visibility, tier, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_md5 ON photos(md5);
CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(upload_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_one_cover
  ON photos(album_id) WHERE tier = 'cover' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id  TEXT,
  action      TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts DESC);
