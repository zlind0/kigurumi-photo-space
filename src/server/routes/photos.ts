import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { PhotoListResponse, Tier, Visibility } from '../../shared/types.js';
import { clampLimit } from '../../shared/cursor.js';
import { canUpload } from '../auth/permissions.js';
import { assertSameOrigin } from '../http/csrf.js';
import { AppError, badRequest, forbidden, notFound, rateLimited, tooLarge, unauthorized, unprocessable } from '../http/errors.js';
import { ConcurrencyLimiter, SlidingWindowLimiter } from '../http/rate-limit.js';
import { getAlbumById, requireVisibleAlbum } from '../services/albums.js';
import {
  createPhoto,
  deletePhoto,
  getPhotoWithAlbum,
  listPhotos,
  photoToDTO,
  requireVisiblePhoto,
  updatePhotoTier,
  updatePhotoVisibility,
} from '../services/photos.js';
import { validateAvifFile } from '../services/avif-validate.js';
import { createTempFile } from '../services/storage.js';

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('照片不存在');
  return id;
}

interface UploadedPart {
  path: string;
  size: number;
  md5: string;
}

export function registerPhotoRoutes(app: FastifyInstance, db: Database, config: Config): void {
  const globalUploads = new ConcurrencyLimiter(config.uploadConcurrency);
  const sessionUploads = new Map<string, ConcurrencyLimiter>();
  const uploadRate = new SlidingWindowLimiter(10, 60_000);

  app.get('/api/albums/:id/photos', async (request, reply) => {
    const { id } = request.params as { id: string };
    const album = requireVisibleAlbum(getAlbumById(db, parseId(id)), request.role);
    const query = request.query as { cursor?: string; limit?: string };
    const result = listPhotos(
      db,
      album,
      request.role,
      query.cursor,
      clampLimit(query.limit, 60, 100),
      request.auth?.session.id ?? null,
    );
    reply.header('cache-control', 'private, no-store');
    return result satisfies PhotoListResponse;
  });

  app.post('/api/albums/:id/photos', async (request, reply) => {
    assertSameOrigin(request, config);
    if (!request.auth) throw unauthorized();
    if (!canUpload(request.role)) throw forbidden('只有上传者可以上传照片');
    const rate = uploadRate.hit(request.ip);
    if (!rate.allowed) {
      reply.header('retry-after', Math.ceil(rate.retryAfterMs / 1000));
      throw rateLimited('上传过于频繁，请稍后再试');
    }
    const { id } = request.params as { id: string };
    const album = requireVisibleAlbum(getAlbumById(db, parseId(id)), request.role);
    const sessionId = request.auth.session.id;
    let sessionLimiter = sessionUploads.get(sessionId);
    if (!sessionLimiter) {
      sessionLimiter = new ConcurrencyLimiter(1);
      sessionUploads.set(sessionId, sessionLimiter);
    }
    const releaseSession = await sessionLimiter.acquire();
    const releaseGlobal = await globalUploads.acquire();
    const tempPaths: string[] = [];
    try {
      const parts = request.parts();
      let full: UploadedPart | null = null;
      let thumb: UploadedPart | null = null;
      let metaRaw: string | null = null;
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'meta') {
            if (typeof part.value !== 'string') throw badRequest('meta 必须是 JSON 字符串');
            if (part.value.length > config.maxJsonBytes) throw tooLarge('meta 字段过大');
            metaRaw = part.value;
          }
          continue;
        }
        if (part.fieldname !== 'full' && part.fieldname !== 'thumb') {
          part.file.resume();
          continue;
        }
        if (part.fieldname === 'full' && full) throw badRequest('重复的 full 文件');
        if (part.fieldname === 'thumb' && thumb) throw badRequest('重复的 thumb 文件');
        const limit = part.fieldname === 'full' ? config.maxFullBytes : config.maxThumbBytes;
        const temp = await createTempFile(config);
        tempPaths.push(temp.path);
        const hash = createHash('md5');
        let size = 0;
        try {
          for await (const chunk of part.file) {
            const buffer = chunk as Buffer;
            size += buffer.byteLength;
            if (size > limit) {
              throw tooLarge(part.fieldname === 'full' ? '全图超过大小限制' : '缩略图超过大小限制');
            }
            hash.update(buffer);
            await temp.handle.write(buffer);
          }
        } finally {
          await temp.handle.close();
        }
        if (part.file.truncated) {
          throw tooLarge(part.fieldname === 'full' ? '全图超过大小限制' : '缩略图超过大小限制');
        }
        const uploaded: UploadedPart = { path: temp.path, size, md5: hash.digest('hex') };
        if (part.fieldname === 'full') full = uploaded;
        else thumb = uploaded;
      }
      if (!full) throw badRequest('缺少 full 文件');
      if (!thumb) throw badRequest('缺少 thumb 文件');
      if (!metaRaw) throw badRequest('缺少 meta 字段');
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(metaRaw) as Record<string, unknown>;
      } catch {
        throw badRequest('meta 不是合法 JSON');
      }
      const fullInfo = await validateAvifFile(full.path, 'full', config);
      const thumbInfo = await validateAvifFile(thumb.path, 'thumb', config);
      if (thumbInfo.width !== 600 || thumbInfo.height !== 600) {
        throw unprocessable('INVALID_THUMBNAIL', '缩略图必须是 600×600');
      }
      const originalName =
        typeof meta.originalName === 'string' ? meta.originalName.slice(0, 255) : null;
      const exifSummary =
        meta.exifSummary && typeof meta.exifSummary === 'object' ? meta.exifSummary : null;
      const result = await createPhoto(db, config, {
        album,
        fullTmpPath: full.path,
        thumbTmpPath: thumb.path,
        fullInfo,
        thumbInfo,
        md5: full.md5,
        thumbMd5: thumb.md5,
        originalName,
        exifJson: exifSummary ? JSON.stringify(exifSummary) : null,
        exifPreserved: meta.exifPreserved === true,
        userId: request.auth.user.id,
        sessionId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply
        .code(result.deduped ? 200 : 201)
        .header('cache-control', 'private, no-store');
      return {
        photo: photoToDTO(result.photo, album, request.role, sessionId),
        deduped: result.deduped,
      };
    } finally {
      releaseGlobal();
      releaseSession();
      for (const path of tempPaths) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  });

  app.patch('/api/photos/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const found = requireVisiblePhoto(db, parseId(id), request.role);
    const body = request.body as { tier?: unknown; visibility?: unknown } | null;
    let photo = found.photo;
    if (body?.tier !== undefined) {
      if (body.tier !== 'cover' && body.tier !== 'featured' && body.tier !== 'other') {
        throw badRequest('tier 必须是 cover、featured 或 other');
      }
      photo = await updatePhotoTier(db, config, {
        photo,
        album: found.album,
        tier: body.tier as Tier,
        userId: request.auth.user.id,
        role: request.role,
        sessionId: request.auth.session.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    if (body?.visibility !== undefined) {
      if (body.visibility !== 'public' && body.visibility !== 'private') {
        throw badRequest('visibility 必须是 public 或 private');
      }
      photo = await updatePhotoVisibility(db, config, {
        photo,
        album: found.album,
        visibility: body.visibility as Visibility,
        userId: request.auth.user.id,
        role: request.role,
        sessionId: request.auth.session.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    reply.header('cache-control', 'private, no-store');
    return { photo: photoToDTO(photo, found.album, request.role, request.auth.session.id) };
  });

  app.delete('/api/photos/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const found = requireVisiblePhoto(db, parseId(id), request.role);
    await deletePhoto(db, config, {
      photo: found.photo,
      album: found.album,
      userId: request.auth.user.id,
      role: request.role,
      sessionId: request.auth.session.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.code(204).send();
  });
}
