import { stat } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { PhotoDTO, Role, Tier, Visibility } from '../../shared/types.js';
import type { AvifInfo } from '../../shared/avif/types.js';
import {
  canManagePhoto,
  canSetPhotoVisibility,
  canSetTier,
  canViewPhoto,
  tierDirectory,
} from '../auth/permissions.js';
import { AppError, conflict, forbidden, notFound, quotaExceeded } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/cursor.js';
import type { AlbumRow, PhotoRow } from './albums.js';
import {
  coverPath,
  coverThumbPath,
  diskInfo,
  fileExists,
  fullPath,
  movePhotoFiles,
  placeFile,
  removePhotoFiles,
  thumbPath,
  updateCoverLinks,
  type PhotoFileRef,
} from './storage.js';
import { audit } from './audit.js';

export function photoFileRef(photo: PhotoRow, album: AlbumRow): PhotoFileRef {
  return {
    albumDir: album.dir_name,
    md5: photo.md5,
    thumbMd5: photo.thumb_md5,
    tier: photo.tier,
    visibility: photo.visibility,
  };
}

export function photoToDTO(
  photo: PhotoRow,
  album: AlbumRow,
  role: Role,
  sessionId: string | null,
): PhotoDTO {
  const dir = encodeURIComponent(album.dir_name);
  const tierDir = tierDirectory(photo.tier, photo.visibility);
  return {
    id: photo.id,
    albumId: photo.album_id,
    md5: photo.md5,
    width: photo.width,
    height: photo.height,
    tier: photo.tier,
    visibility: photo.visibility,
    createdAt: photo.created_at,
    originalName: photo.original_name,
    thumbUrl: `/m/${dir}/${tierDir}/${photo.md5}.thumb.avif`,
    fullUrl: `/m/${dir}/${tierDir}/${photo.md5}.avif`,
    bitDepth: photo.bit_depth,
    isHdr: photo.is_hdr !== 0,
    hasAlpha: photo.has_alpha !== 0,
    canDelete: canManagePhoto(role, photo, sessionId),
    canSetTier: canSetTier(role, photo, sessionId),
    canSetVisibility: canSetPhotoVisibility(role),
  };
}

export function getPhotoById(db: Database, id: number): PhotoRow | null {
  return db.get<PhotoRow>('SELECT * FROM photos WHERE id = ? AND deleted_at IS NULL', id) ?? null;
}

export function getPhotoWithAlbum(
  db: Database,
  id: number,
): { photo: PhotoRow; album: AlbumRow } | null {
  const photo = getPhotoById(db, id);
  if (!photo) return null;
  const album = db.get<AlbumRow>('SELECT * FROM albums WHERE id = ? AND deleted_at IS NULL', photo.album_id);
  if (!album) return null;
  return { photo, album };
}

export interface PhotoListResult {
  items: PhotoDTO[];
  nextCursor: string | null;
}

export function listPhotos(
  db: Database,
  album: AlbumRow,
  role: Role,
  cursorRaw: string | undefined,
  limit: number,
  sessionId: string | null = null,
): PhotoListResult {
  const cursor = decodeCursor(cursorRaw);
  const params: unknown[] = [album.id];
  let where = 'album_id = ? AND deleted_at IS NULL';
  if (role === 'public') where += " AND visibility = 'public'";
  if (cursor) {
    where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);
  const rows = db.all<PhotoRow>(
    `SELECT * FROM photos WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((photo) => photoToDTO(photo, album, role, sessionId)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

export function listFeatured(db: Database, album: AlbumRow, role: Role, limit = 100): PhotoRow[] {
  const visibilityClause = role === 'public' ? "AND visibility = 'public'" : '';
  return db.all<PhotoRow>(
    `SELECT * FROM photos
     WHERE album_id = ? AND tier = 'featured' AND deleted_at IS NULL ${visibilityClause}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    album.id,
    limit,
  );
}

function findCover(db: Database, albumId: number): PhotoRow | null {
  return (
    db.get<PhotoRow>(
      "SELECT * FROM photos WHERE album_id = ? AND tier = 'cover' AND deleted_at IS NULL LIMIT 1",
      albumId,
    ) ?? null
  );
}

function findPromotionCandidate(db: Database, albumId: number, excludeId: number): PhotoRow | null {
  return (
    db.get<PhotoRow>(
      `SELECT * FROM photos
       WHERE album_id = ? AND id != ? AND deleted_at IS NULL AND tier = 'featured'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      albumId,
      excludeId,
    ) ??
    db.get<PhotoRow>(
      `SELECT * FROM photos
       WHERE album_id = ? AND id != ? AND deleted_at IS NULL AND tier = 'other'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      albumId,
      excludeId,
    ) ??
    null
  );
}

export async function promoteCover(
  db: Database,
  config: Config,
  album: AlbumRow,
  excludeId = -1,
): Promise<PhotoRow | null> {
  const candidate = findPromotionCandidate(db, album.id, excludeId);
  if (!candidate) {
    await updateCoverLinks(config, album.dir_name, null);
    return null;
  }
  const fromRef = photoFileRef(candidate, album);
  const toRef: PhotoFileRef = { ...fromRef, tier: 'cover' };
  if (candidate.visibility === 'public') {
    await movePhotoFiles(config, fromRef, toRef);
  }
  db.run("UPDATE photos SET tier = 'featured' WHERE album_id = ? AND tier = 'cover' AND deleted_at IS NULL", album.id);
  db.run("UPDATE photos SET tier = 'cover' WHERE id = ?", candidate.id);
  const updated = { ...candidate, tier: 'cover' as const };
  await updateCoverLinks(config, album.dir_name, toRef);
  return updated;
}

export async function setCover(
  db: Database,
  config: Config,
  album: AlbumRow,
  photo: PhotoRow,
): Promise<PhotoRow> {
  if (album.visibility === 'public' && photo.visibility === 'private') {
    throw conflict('COVER_MUST_BE_PUBLIC', '公开相册的封面必须是公开照片');
  }
  const fromRef = photoFileRef(photo, album);
  const toRef: PhotoFileRef = { ...fromRef, tier: 'cover' };
  if (photo.visibility === 'public') {
    await movePhotoFiles(config, fromRef, toRef);
  }
  const current = findCover(db, album.id);
  if (current && current.id !== photo.id) {
    db.run("UPDATE photos SET tier = 'featured' WHERE id = ?", current.id);
  }
  db.run("UPDATE photos SET tier = 'cover' WHERE id = ?", photo.id);
  const updated = { ...photo, tier: 'cover' as const };
  await updateCoverLinks(config, album.dir_name, toRef);
  return updated;
}

export interface PhotoMutationContext {
  userId: number;
  role: Role;
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
}

export async function updatePhotoTier(
  db: Database,
  config: Config,
  input: PhotoMutationContext & { photo: PhotoRow; album: AlbumRow; tier: Tier },
): Promise<PhotoRow> {
  const { photo, album, tier } = input;
  if (!canSetTier(input.role, photo, input.sessionId)) {
    throw forbidden('没有权限修改这张照片的档次');
  }
  if (tier === photo.tier) return photo;
  if (tier === 'cover') {
    const updated = await setCover(db, config, album, photo);
    audit(db, {
      userId: input.userId,
      sessionId: input.sessionId,
      action: 'photo.tier',
      ip: input.ip,
      userAgent: input.userAgent,
      targetType: 'photo',
      targetId: photo.id,
      detail: { from: photo.tier, to: tier },
    });
    return updated;
  }

  const fromRef = photoFileRef(photo, album);
  const toRef: PhotoFileRef = { ...fromRef, tier };
  if (photo.tier === 'cover') {
    db.run("UPDATE photos SET tier = 'featured' WHERE id = ?", photo.id);
    await promoteCover(db, config, album, photo.id);
  }
  db.run('UPDATE photos SET tier = ? WHERE id = ?', tier, photo.id);
  if (photo.visibility === 'public') {
    await movePhotoFiles(config, fromRef, toRef);
  }
  const updated = { ...photo, tier };
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'photo.tier',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'photo',
    targetId: photo.id,
    detail: { from: photo.tier, to: tier },
  });
  return updated;
}

export async function updatePhotoVisibility(
  db: Database,
  config: Config,
  input: PhotoMutationContext & { photo: PhotoRow; album: AlbumRow; visibility: Visibility },
): Promise<PhotoRow> {
  const { photo, album, visibility } = input;
  if (!canSetPhotoVisibility(input.role)) throw forbidden('只有管理员可以修改照片可见度');
  if (visibility === photo.visibility) return photo;
  if (visibility === 'private' && photo.tier === 'cover' && album.visibility === 'public') {
    throw conflict('COVER_MUST_BE_PUBLIC', '公开相册的封面必须是公开照片');
  }
  const fromRef = photoFileRef(photo, album);
  const toRef: PhotoFileRef = { ...fromRef, visibility };
  await movePhotoFiles(config, fromRef, toRef);
  db.run('UPDATE photos SET visibility = ? WHERE id = ?', visibility, photo.id);
  const updated = { ...photo, visibility };
  if (updated.tier === 'cover') {
    await updateCoverLinks(config, album.dir_name, photoFileRef(updated, album));
  }
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'photo.visibility',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'photo',
    targetId: photo.id,
    detail: { from: photo.visibility, to: visibility },
  });
  return updated;
}

export async function deletePhoto(
  db: Database,
  config: Config,
  input: PhotoMutationContext & { photo: PhotoRow; album: AlbumRow },
): Promise<void> {
  const { photo, album } = input;
  if (!canManagePhoto(input.role, photo, input.sessionId)) {
    throw forbidden('没有权限删除这张照片');
  }
  if (photo.tier === 'cover') {
    db.run("UPDATE photos SET tier = 'featured' WHERE id = ?", photo.id);
    await promoteCover(db, config, album, photo.id);
  }
  await removePhotoFiles(config, photoFileRef(photo, album));
  db.run('DELETE FROM photos WHERE id = ?', photo.id);
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'photo.delete',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'photo',
    targetId: photo.id,
    detail: { albumId: album.id, md5: photo.md5 },
  });
}

export interface CreatePhotoInput {
  album: AlbumRow;
  fullTmpPath: string;
  thumbTmpPath: string;
  fullInfo: AvifInfo;
  thumbInfo: AvifInfo;
  md5: string;
  thumbMd5: string;
  originalName: string | null;
  exifJson: string | null;
  exifPreserved: boolean;
  userId: number;
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface CreatePhotoResult {
  photo: PhotoRow;
  deduped: boolean;
}

export async function createPhoto(
  db: Database,
  config: Config,
  input: CreatePhotoInput,
): Promise<CreatePhotoResult> {
  const { album } = input;
  const existing = db.get<PhotoRow>(
    'SELECT * FROM photos WHERE album_id = ? AND md5 = ? AND deleted_at IS NULL',
    album.id,
    input.md5,
  );
  if (existing) {
    return { photo: existing, deduped: true };
  }
  const count = db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM photos WHERE album_id = ? AND deleted_at IS NULL',
    album.id,
  );
  if ((count?.c ?? 0) >= config.maxPhotosPerAlbum) {
    throw new AppError(429, 'RATE_LIMITED', '相册照片数量已达上限');
  }
  const disk = await diskInfo(config);
  if (disk.free > 0 && disk.free < config.minFreeBytes) {
    throw quotaExceeded('服务器磁盘空间不足');
  }
  const total = db.get<{ total: number }>(
    'SELECT COALESCE(SUM(size_bytes + thumb_size_bytes), 0) AS total FROM photos WHERE deleted_at IS NULL',
  );
  const incoming = (await stat(input.fullTmpPath)).size + (await stat(input.thumbTmpPath)).size;
  if ((total?.total ?? 0) + incoming > config.maxTotalBytes) {
    throw quotaExceeded('站点存储配额已满');
  }

  const cover = findCover(db, album.id);
  const tier: Tier = cover ? 'other' : 'cover';
  const visibility: Visibility = 'public';
  const ref: PhotoFileRef = {
    albumDir: album.dir_name,
    md5: input.md5,
    thumbMd5: input.thumbMd5,
    tier,
    visibility,
  };
  const targetFull = fullPath(config, ref);
  const targetThumb = thumbPath(config, ref);

  const global = db.get<PhotoRow & { dir_name: string }>(
    `SELECT p.*, a.dir_name FROM photos p JOIN albums a ON a.id = p.album_id
     WHERE p.md5 = ? AND p.deleted_at IS NULL AND a.deleted_at IS NULL
     ORDER BY p.id ASC LIMIT 1`,
    input.md5,
  );
  const globalThumb = db.get<PhotoRow & { dir_name: string }>(
    `SELECT p.*, a.dir_name FROM photos p JOIN albums a ON a.id = p.album_id
     WHERE p.thumb_md5 = ? AND p.deleted_at IS NULL AND a.deleted_at IS NULL
     ORDER BY p.id ASC LIMIT 1`,
    input.thumbMd5,
  );
  const existingFull = global
    ? fullPath(config, {
        albumDir: global.dir_name,
        md5: global.md5,
        thumbMd5: global.thumb_md5,
        tier: global.tier,
        visibility: global.visibility,
      })
    : null;
  const existingThumb = globalThumb
    ? thumbPath(config, {
        albumDir: globalThumb.dir_name,
        md5: globalThumb.md5,
        thumbMd5: globalThumb.thumb_md5,
        tier: globalThumb.tier,
        visibility: globalThumb.visibility,
      })
    : null;

  let fullPlaced = false;
  let thumbPlaced = false;
  try {
    await placeFile(config, input.fullTmpPath, targetFull, existingFull);
    fullPlaced = true;
    await placeFile(config, input.thumbTmpPath, targetThumb, existingThumb);
    thumbPlaced = true;
    const fullStat = await stat(targetFull);
    const thumbStat = await stat(targetThumb);
    const now = Date.now();
    const result = db.run(
      `INSERT INTO photos
        (album_id, md5, thumb_md5, width, height, size_bytes, thumb_size_bytes, tier, visibility,
         original_name, mime, exif_json, created_at, uploaded_by, upload_session_id,
         bit_depth, is_hdr, has_alpha, color_primaries, transfer_characteristics, matrix_coefficients, exif_preserved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/avif', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      album.id,
      input.md5,
      input.thumbMd5,
      input.fullInfo.width,
      input.fullInfo.height,
      fullStat.size,
      thumbStat.size,
      tier,
      visibility,
      input.originalName,
      input.exifJson,
      now,
      input.userId,
      input.sessionId,
      input.fullInfo.bitDepth,
      input.fullInfo.isHdr ? 1 : 0,
      input.fullInfo.hasAlpha ? 1 : 0,
      input.fullInfo.color?.primaries ?? null,
      input.fullInfo.color?.transfer ?? null,
      input.fullInfo.color?.matrix ?? null,
      input.exifPreserved ? 1 : 0,
    );
    const photo = getPhotoById(db, result.lastInsertRowid);
    if (!photo) throw new AppError(500, 'INTERNAL', '写入照片失败');
    if (tier === 'cover') {
      await updateCoverLinks(config, album.dir_name, ref);
    }
    audit(db, {
      userId: input.userId,
      sessionId: input.sessionId,
      action: 'photo.upload',
      ip: input.ip,
      userAgent: input.userAgent,
      targetType: 'photo',
      targetId: photo.id,
      detail: {
        albumId: album.id,
        md5: input.md5,
        width: photo.width,
        height: photo.height,
        bitDepth: photo.bit_depth,
        hdr: photo.is_hdr !== 0,
        exifPreserved: input.exifPreserved,
      },
    });
    return { photo, deduped: false };
  } catch (error) {
    if (fullPlaced) await removePhotoFiles(config, ref);
    if (thumbPlaced) await removePhotoFiles(config, ref);
    throw error;
  }
}

export function requireVisiblePhoto(
  db: Database,
  id: number,
  role: Role,
): { photo: PhotoRow; album: AlbumRow } {
  const found = getPhotoWithAlbum(db, id);
  if (!found) throw notFound('照片不存在');
  if (!canViewPhoto(found.photo, role)) throw notFound('照片不存在');
  return found;
}

export async function coverExists(config: Config, album: AlbumRow): Promise<boolean> {
  return (await fileExists(coverPath(config, album.dir_name))) && (await fileExists(coverThumbPath(config, album.dir_name)));
}
