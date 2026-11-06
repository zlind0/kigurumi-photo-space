CREATE TABLE IF NOT EXISTS people (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  accent_hue         INTEGER NOT NULL DEFAULT 330,
  accent_saturation  INTEGER NOT NULL DEFAULT 70,
  accent_lightness   INTEGER NOT NULL DEFAULT 80,
  avatar_md5         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_people_created ON people(created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS album_people (
  album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_album_people_person ON album_people(person_id, album_id);
