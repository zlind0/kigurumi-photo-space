import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { AlbumDetailResponse, AlbumListResponse, PermissionsDTO, Visibility } from '../../shared/types.js';
import { clampLimit } from '../../shared/cursor.js';
import { canCreateAlbum, canManageAlbum, canSetVisibility, canUpload } from '../auth/permissions.js';
import { assertSameOrigin } from '../http/csrf.js';
import { badRequest, forbidden, notFound, rateLimited, unauthorized } from '../http/errors.js';
import {
  albumToDTO,
  countVisiblePhotos,
  createAlbum,
  deleteAlbum,
  getAlbumById,
  getCoverPhoto,
  listAlbums,
  requireVisibleAlbum,
  updateAlbumVisibility,
} from '../services/albums.js';
import { listFeatured, listPhotos, photoToDTO } from '../services/photos.js';
import { listPeopleForAlbum, personToDTO } from '../services/people.js';
import { SlidingWindowLimiter } from '../http/rate-limit.js';

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('相册不存在');
  return id;
}

export function registerAlbumRoutes(app: FastifyInstance, db: Database, config: Config): void {
  const createRate = new SlidingWindowLimiter(10, 3_600_000);

  app.get('/api/albums', async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string; people?: string };
    const personIds = (query.people ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const result = listAlbums(
      db,
      request.role,
      query.cursor,
      clampLimit(query.limit, 50, 100),
      Array.from(new Set(personIds)),
    );
    reply.header('cache-control', 'private, no-store');
    return result satisfies AlbumListResponse;
  });

  app.post('/api/albums', async (request, reply) => {
    assertSameOrigin(request, config);
    if (!request.auth) throw unauthorized();
    if (!canCreateAlbum(request.role)) throw forbidden('只有上传者可以新建相册');
    const rate = createRate.hit(String(request.auth.user.id));
    if (!rate.allowed) {
      reply.header('retry-after', Math.ceil(rate.retryAfterMs / 1000));
      throw rateLimited('创建相册过于频繁，请稍后再试');
    }
    const body = request.body as { name?: unknown } | null;
    const album = createAlbum(db, config, {
      name: body?.name,
      userId: request.auth.user.id,
      role: request.role,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      sessionId: request.auth.session.id,
    });
    reply.code(201).header('cache-control', 'private, no-store');
    return { album: albumToDTO(album, null, 0, request.role) };
  });

  app.get('/api/albums/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const album = requireVisibleAlbum(getAlbumById(db, parseId(id)), request.role);
    const sessionId = request.auth?.session.id ?? null;
    const cover = getCoverPhoto(db, album.id, request.role);
    const featured = listFeatured(db, album, request.role).map((photo) =>
      photoToDTO(photo, album, request.role, sessionId),
    );
    const photos = listPhotos(db, album, request.role, undefined, 60, sessionId);
    const people = listPeopleForAlbum(db, album.id).map(personToDTO);
    const permissions: PermissionsDTO = {
      canUpload: canUpload(request.role),
      canCreateAlbum: canCreateAlbum(request.role),
      canManageAlbum: canManageAlbum(request.role),
      canSetTier: canUpload(request.role),
      canSetVisibility: canSetVisibility(request.role),
    };
    reply.header('cache-control', 'private, no-store');
    return {
      album: albumToDTO(album, cover, countVisiblePhotos(db, album.id, request.role), request.role, people),
      cover: cover ? photoToDTO(cover, album, request.role, sessionId) : null,
      featured,
      photos,
      permissions,
    } satisfies AlbumDetailResponse;
  });

  app.patch('/api/albums/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const album = requireVisibleAlbum(getAlbumById(db, parseId(id)), request.role);
    const body = request.body as { visibility?: unknown } | null;
    const visibility = body?.visibility;
    if (visibility !== 'public' && visibility !== 'private') {
      throw badRequest('visibility 必须是 public 或 private');
    }
    const updated = updateAlbumVisibility(db, {
      album,
      visibility: visibility as Visibility,
      userId: request.auth.user.id,
      role: request.role,
      sessionId: request.auth.session.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.header('cache-control', 'private, no-store');
    return {
      album: albumToDTO(
        updated,
        getCoverPhoto(db, updated.id, request.role),
        countVisiblePhotos(db, updated.id, request.role),
        request.role,
        listPeopleForAlbum(db, updated.id).map(personToDTO),
      ),
    };
  });

  app.delete('/api/albums/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const album = requireVisibleAlbum(getAlbumById(db, parseId(id)), request.role);
    await deleteAlbum(db, config, {
      album,
      userId: request.auth.user.id,
      role: request.role,
      sessionId: request.auth.session.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.code(204).send();
  });
}
