import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { canViewAlbum } from '../auth/permissions.js';
import { notFound } from '../http/errors.js';
import { getAlbumByDir, type AlbumRow } from '../services/albums.js';
import { getCachedAlbum } from '../services/album-cache.js';
import { albumPath, peopleDir } from '../services/storage.js';

const FILE_RE = /^[a-f0-9]{32}(\.thumb)?\.avif$/;
const COVER_RE = /^cover(\.thumb)?\.avif$/;
const PERSON_AVATAR_RE = /^[a-f0-9]{32}\.avif$/;

export function registerMediaRoutes(app: FastifyInstance, db: Database, config: Config): void {
  function lookup(dirName: string): AlbumRow | null {
    return getCachedAlbum(dirName, () => getAlbumByDir(db, dirName));
  }

  async function serve(
    request: FastifyRequest,
    reply: FastifyReply,
    album: AlbumRow,
    relativePath: string,
    isPrivate: boolean,
  ): Promise<FastifyReply> {
    const root = albumPath(config, album.dir_name);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + sep)) throw notFound();
    let info;
    try {
      info = await lstat(target);
    } catch {
      throw notFound();
    }
    if (!info.isFile() || info.isSymbolicLink()) throw notFound();
    const etag = `"${relativePath.replace(/[^a-z0-9.]/gi, '')}-${info.size}"`;
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some((value) => value.trim() === etag)) {
      return reply.code(304).header('etag', etag).send();
    }
    reply
      .header('content-type', 'image/avif')
      .header('content-length', String(info.size))
      .header('etag', etag)
      .header('cache-control', `${isPrivate ? 'private' : 'public'}, max-age=31536000, immutable`)
      .header('x-content-type-options', 'nosniff');
    if (request.method === 'HEAD') {
      return reply.send();
    }
    return reply.send(createReadStream(target));
  }

  app.get('/p/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!PERSON_AVATAR_RE.test(file)) throw notFound();
    const root = peopleDir(config);
    const target = resolve(root, file);
    if (target !== root && !target.startsWith(root + sep)) throw notFound();
    let info;
    try {
      info = await lstat(target);
    } catch {
      throw notFound();
    }
    if (!info.isFile() || info.isSymbolicLink()) throw notFound();
    const etag = `"${file}-${info.size}"`;
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some((value) => value.trim() === etag)) {
      return reply.code(304).header('etag', etag).send();
    }
    reply
      .header('content-type', 'image/avif')
      .header('content-length', String(info.size))
      .header('etag', etag)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff');
    if (request.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(target));
  });

  app.get('/m/:albumDir/cover.avif', async (request, reply) => {
    const { albumDir } = request.params as { albumDir: string };
    const album = lookup(albumDir);
    if (!album || !canViewAlbum(album, request.role)) throw notFound();
    return serve(request, reply, album, 'cover.avif', album.visibility === 'private');
  });

  app.get('/m/:albumDir/cover.thumb.avif', async (request, reply) => {
    const { albumDir } = request.params as { albumDir: string };
    const album = lookup(albumDir);
    if (!album || !canViewAlbum(album, request.role)) throw notFound();
    return serve(request, reply, album, 'cover.thumb.avif', album.visibility === 'private');
  });

  app.get('/m/:albumDir/:tier/:file', async (request, reply) => {
    const { albumDir, tier, file } = request.params as { albumDir: string; tier: string; file: string };
    if (tier !== 'top' && tier !== 'others' && tier !== 'hidden') throw notFound();
    if (!FILE_RE.test(file) && !COVER_RE.test(file)) throw notFound();
    const album = lookup(albumDir);
    if (!album || !canViewAlbum(album, request.role)) throw notFound();
    if (tier === 'hidden' && request.role === 'public') throw notFound();
    const isPrivate = album.visibility === 'private' || tier === 'hidden';
    return serve(request, reply, album, join(tier, file), isPrivate);
  });
}
