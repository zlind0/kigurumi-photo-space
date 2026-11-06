-- 同一相册内按原始文件名去重时使用。
CREATE INDEX IF NOT EXISTS idx_photos_album_name
  ON photos(album_id, original_name)
  WHERE deleted_at IS NULL;
