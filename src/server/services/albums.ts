import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { AlbumDTO, CoverDTO, PersonDTO, Role, Visibility } from '../../shared/types.js';
import { canCreateAlbum, canManageAlbum, canUpload, canViewAlbum } from '../auth/permissions.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/cursor.js';
import { deleteAlbumToTrash, ensureAlbumDirs, renameAlbumDir } from './storage.js';
import { audit } from './audit.js';
import { invalidateAlbum } from './album-cache.js';
import { listPeopleForAlbums, personToDTO } from './people.js';

export interface AlbumRow {
  id: number;
  name: string;
  dir_name: string;
  dir_key: string;
  visibility: Visibility;
  created_at: number;
  created_by: number | null;
  deleted_at: number | null;
}

export interface PhotoRow {
  id: number;
  album_id: number;
  md5: string;
  thumb_md5: string;
  width: number;
  height: number;
  size_bytes: number;
  thumb_size_bytes: number;
  preview_size_bytes: number;
  tier: 'cover' | 'featured' | 'other';
  visibility: Visibility;
  original_name: string | null;
  mime: string;
  exif_json: string | null;
  created_at: number;
  uploaded_by: number | null;
  upload_session_id: string | null;
  deleted_at: number | null;
  bit_depth: number;
  is_hdr: number;
  has_alpha: number;
  color_primaries: number | null;
  transfer_characteristics: number | null;
  matrix_coefficients: number | null;
  exif_preserved: number;
}

const RESERVED_DIRS = new Set([
  'tmp',
  '.trash',
  'backups',
  'db.sqlite',
  'db.sqlite-wal',
  'db.sqlite-shm',
  '.secret',
  'cover',
  'top',
  'others',
  'hidden',
  'data',
  'assets',
  'wasm',
  'people',
]);

export interface SanitizedAlbumName {
  name: string;
  dirName: string;
  dirKey: string;
}

export function sanitizeAlbumName(raw: unknown, maxLength = 80): SanitizedAlbumName {
  if (typeof raw !== 'string') throw badRequest('相册名必须是字符串');
  const name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!name) throw badRequest('相册名不能为空');
  if (!/[^\s.]/.test(name)) throw badRequest('相册名不合法');
  if ([...name].length > maxLength) throw badRequest(`相册名不能超过 ${maxLength} 个字符`);
  let dirName = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLength)
    .replace(/[.\s]+$/g, '');
  if (!dirName) throw badRequest('相册名不合法');
  if (RESERVED_DIRS.has(dirName.toLowerCase())) dirName = `_${dirName}`;
  const dirKey = dirName.normalize('NFC').toLocaleLowerCase('und');
  return { name, dirName, dirKey };
}

export function albumToDTO(
  album: AlbumRow,
  cover: PhotoRow | null,
  photoCount: number,
  role: Role,
  people: PersonDTO[] = [],
): AlbumDTO {
  const dir = encodeURIComponent(album.dir_name);
  const coverDTO: CoverDTO | null = cover
    ? {
        photoId: cover.id,
        thumbUrl: `/m/${dir}/cover.thumb.avif?v=${cover.md5}`,
        fullUrl: `/m/${dir}/cover.avif?v=${cover.md5}`,
        width: cover.width,
        height: cover.height,
        isHdr: cover.is_hdr !== 0,
      }
    : null;
  return {
    id: album.id,
    name: album.name,
    dir: album.dir_name,
    visibility: album.visibility,
    createdAt: album.created_at,
    photoCount,
    cover: coverDTO,
    people,
    canUpload: canUpload(role),
    canManage: canManageAlbum(role),
  };
}

export function getAlbumById(db: Database, id: number): AlbumRow | null {
  return (
    db.get<AlbumRow>('SELECT * FROM albums WHERE id = ? AND deleted_at IS NULL', id) ?? null
  );
}

export function getAlbumByDir(db: Database, dirName: string): AlbumRow | null {
  return (
    db.get<AlbumRow>('SELECT * FROM albums WHERE dir_name = ? AND deleted_at IS NULL', dirName) ??
    null
  );
}

export function getCoverPhoto(db: Database, albumId: number, role: Role): PhotoRow | null {
  const visibilityClause = role === 'public' ? "AND p.visibility = 'public'" : '';
  return (
    db.get<PhotoRow>(
      `SELECT p.* FROM photos p
       WHERE p.album_id = ? AND p.tier = 'cover' AND p.deleted_at IS NULL ${visibilityClause}
       LIMIT 1`,
      albumId,
    ) ?? null
  );
}

export function countVisiblePhotos(db: Database, albumId: number, role: Role): number {
  const visibilityClause = role === 'public' ? "AND visibility = 'public'" : '';
  const row = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM photos WHERE album_id = ? AND deleted_at IS NULL ${visibilityClause}`,
    albumId,
  );
  return row?.c ?? 0;
}

/**
 * 公开相册里允许存在私密照片。当相册内所有未删除的照片都是私密时，
 * 相册本身自动转为私密，避免首页出现一个点进去什么都没有的公开相册。
 * 只在“公开 → 私密”方向自动切换，手动设为公开的相册不会被覆盖。
 */
export function syncAlbumVisibility(db: Database, album: AlbumRow): AlbumRow {
  if (album.visibility !== 'public') return album;
  const row = db.get<{ total: number; hidden: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN visibility = 'private' THEN 1 ELSE 0 END), 0) AS hidden
       FROM photos WHERE album_id = ? AND deleted_at IS NULL`,
    album.id,
  );
  if (!row || row.total === 0 || row.hidden < row.total) return album;
  db.run("UPDATE albums SET visibility = 'private' WHERE id = ?", album.id);
  invalidateAlbum(album.dir_name);
  return { ...album, visibility: 'private' };
}

export interface AlbumListResult {
  albums: AlbumDTO[];
  nextCursor: string | null;
}

export function listAlbums(
  db: Database,
  role: Role,
  cursorRaw: string | undefined,
  limit: number,
  personIds: number[] = [],
): AlbumListResult {
  const cursor = decodeCursor(cursorRaw);
  const params: unknown[] = [];
  let where = 'a.deleted_at IS NULL';
  if (role === 'public') where += " AND a.visibility = 'public'";
  if (personIds.length > 0) {
    const placeholders = personIds.map(() => '?').join(',');
    where += ` AND EXISTS (
      SELECT 1 FROM album_people ap
      WHERE ap.album_id = a.id AND ap.person_id IN (${placeholders})
    )`;
    params.push(...personIds);
  }
  if (cursor) {
    where += ' AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))';
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);
  const rows = db.all<AlbumRow & { photo_count: number; cover_id: number | null }>(
    `SELECT a.*,
       (SELECT COUNT(*) FROM photos p
         WHERE p.album_id = a.id AND p.deleted_at IS NULL
           ${role === 'public' ? "AND p.visibility = 'public'" : ''}) AS photo_count,
       (SELECT p.id FROM photos p
         WHERE p.album_id = a.id AND p.tier = 'cover' AND p.deleted_at IS NULL
           ${role === 'public' ? "AND p.visibility = 'public'" : ''}
         LIMIT 1) AS cover_id
     FROM albums a
     WHERE ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ?`,
    ...params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const coverIds = page.map((row) => row.cover_id).filter((id): id is number => id !== null);
  const covers = new Map<number, PhotoRow>();
  if (coverIds.length > 0) {
    const placeholders = coverIds.map(() => '?').join(',');
    for (const photo of db.all<PhotoRow>(`SELECT * FROM photos WHERE id IN (${placeholders})`, ...coverIds)) {
      covers.set(photo.id, photo);
    }
  }
  const peopleByAlbum = listPeopleForAlbums(
    db,
    page.map((row) => row.id),
  );
  const albums = page.map((row) =>
    albumToDTO(
      row,
      row.cover_id ? (covers.get(row.cover_id) ?? null) : null,
      row.photo_count,
      role,
      (peopleByAlbum.get(row.id) ?? []).map(personToDTO),
    ),
  );
  const last = page[page.length - 1];
  return {
    albums,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

export function listAlbumOptions(db: Database, role: Role): AlbumRow[] {
  const where = role === 'public' ? "AND visibility = 'public'" : '';
  return db.all<AlbumRow>(
    `SELECT * FROM albums WHERE deleted_at IS NULL ${where}
     ORDER BY created_at DESC, id DESC LIMIT 500`,
  );
}

export function createAlbum(
  db: Database,
  config: Config,
  input: { name: unknown; userId: number; role: Role; ip: string | null; userAgent: string | null; sessionId: string },
): AlbumRow {
  if (!canCreateAlbum(input.role)) throw forbidden('只有上传者可以新建相册');
  const sanitized = sanitizeAlbumName(input.name, config.maxAlbumNameLength);
  const existing = db.get<{ id: number }>('SELECT id FROM albums WHERE dir_key = ?', sanitized.dirKey);
  if (existing) throw conflict('ALBUM_NAME_TAKEN', '相册名已存在');
  const count = db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM albums WHERE created_by = ? AND deleted_at IS NULL',
    input.userId,
  );
  if ((count?.c ?? 0) >= config.maxAlbumsPerUser) {
    throw new AppError(429, 'RATE_LIMITED', '相册数量已达上限');
  }
  const now = Date.now();
  const result = db.run(
    `INSERT INTO albums (name, dir_name, dir_key, visibility, created_at, created_by)
     VALUES (?, ?, ?, 'public', ?, ?)`,
    sanitized.name,
    sanitized.dirName,
    sanitized.dirKey,
    now,
    input.userId,
  );
  const album = getAlbumById(db, result.lastInsertRowid);
  if (!album) throw new AppError(500, 'INTERNAL', '创建相册失败');
  try {
    void ensureAlbumDirs(config, album.dir_name);
  } catch (error) {
    db.run('DELETE FROM albums WHERE id = ?', album.id);
    throw error;
  }
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'album.create',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'album',
    targetId: album.id,
    detail: { name: album.name, dir: album.dir_name },
  });
  return album;
}

export function updateAlbumVisibility(
  db: Database,
  input: {
    album: AlbumRow;
    visibility: Visibility;
    userId: number;
    role: Role;
    sessionId: string;
    ip: string | null;
    userAgent: string | null;
  },
): AlbumRow {
  if (!canManageAlbum(input.role)) throw forbidden('只有管理员可以修改相册可见度');
  if (input.visibility === input.album.visibility) return input.album;
  if (input.visibility === 'public') {
    const cover = db.get<PhotoRow>(
      "SELECT * FROM photos WHERE album_id = ? AND tier = 'cover' AND deleted_at IS NULL LIMIT 1",
      input.album.id,
    );
    if (cover && cover.visibility === 'private') {
      throw conflict('COVER_MUST_BE_PUBLIC', '公开相册的封面必须是公开照片');
    }
  }
  db.run('UPDATE albums SET visibility = ? WHERE id = ?', input.visibility, input.album.id);
  invalidateAlbum(input.album.dir_name);
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'album.visibility',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'album',
    targetId: input.album.id,
    detail: { from: input.album.visibility, to: input.visibility },
  });
  return { ...input.album, visibility: input.visibility };
}

export async function updateAlbumName(
  db: Database,
  config: Config,
  input: {
    album: AlbumRow;
    name: unknown;
    userId: number;
    role: Role;
    sessionId: string;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<AlbumRow> {
  if (!canManageAlbum(input.role)) throw forbidden('只有管理员可以修改相册名');
  const sanitized = sanitizeAlbumName(input.name, config.maxAlbumNameLength);
  if (sanitized.name === input.album.name && sanitized.dirName === input.album.dir_name) {
    return input.album;
  }
  const existing = db.get<{ id: number }>(
    'SELECT id FROM albums WHERE dir_key = ? AND id <> ?',
    sanitized.dirKey,
    input.album.id,
  );
  if (existing) throw conflict('ALBUM_NAME_TAKEN', '相册名已存在');
  try {
    await renameAlbumDir(config, input.album.dir_name, sanitized.dirName);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw conflict('ALBUM_DIR_TAKEN', '相册目录已存在，请换一个名字');
  }
  db.run(
    'UPDATE albums SET name = ?, dir_name = ?, dir_key = ? WHERE id = ?',
    sanitized.name,
    sanitized.dirName,
    sanitized.dirKey,
    input.album.id,
  );
  invalidateAlbum(input.album.dir_name);
  invalidateAlbum(sanitized.dirName);
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'album.rename',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'album',
    targetId: input.album.id,
    detail: { from: input.album.name, to: sanitized.name, fromDir: input.album.dir_name, toDir: sanitized.dirName },
  });
  return {
    ...input.album,
    name: sanitized.name,
    dir_name: sanitized.dirName,
    dir_key: sanitized.dirKey,
  };
}

export async function deleteAlbum(
  db: Database,
  config: Config,
  input: {
    album: AlbumRow;
    userId: number;
    role: Role;
    sessionId: string;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  if (!canManageAlbum(input.role)) throw forbidden('只有管理员可以删除相册');
  await deleteAlbumToTrash(config, input.album.dir_name);
  invalidateAlbum(input.album.dir_name);
  db.run('DELETE FROM albums WHERE id = ?', input.album.id);
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'album.delete',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'album',
    targetId: input.album.id,
    detail: { name: input.album.name, dir: input.album.dir_name },
  });
}

export function requireVisibleAlbum(album: AlbumRow | null, role: Role): AlbumRow {
  if (!album || !canViewAlbum(album, role)) throw notFound('相册不存在');
  return album;
}
