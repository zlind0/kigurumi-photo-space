import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { PermissionsDTO } from '../../shared/types.js';
import { canCreateAlbum, canManageAlbum, canSetVisibility, canUpload } from '../auth/permissions.js';
import { notFound } from '../http/errors.js';
import {
  albumToDTO,
  countVisiblePhotos,
  getAlbumByDir,
  listAlbumOptions,
  listAlbums,
  requireVisibleAlbum,
} from '../services/albums.js';
import { listPhotos, photoToDTO } from '../services/photos.js';
import { listPeople, listPeopleForAlbum, personToDTO } from '../services/people.js';
import { diskInfo } from '../services/storage.js';
import { renderHomePage } from '../templates/home.js';
import { renderAlbumPage } from '../templates/album.js';
import { renderUploadPage } from '../templates/upload.js';
import { renderAdminPage } from '../templates/admin.js';
import { renderLayout, type AssetManifest } from '../templates/layout.js';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(
  request: FastifyRequest,
  reply: FastifyReply,
  root: string,
  relative: string,
  immutable: boolean,
): Promise<FastifyReply> {
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) throw notFound();
  let info;
  try {
    info = await stat(target);
  } catch {
    throw notFound();
  }
  if (!info.isFile()) throw notFound();
  const ext = extname(target).toLowerCase();
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch.split(',').some((value) => value.trim() === etag)) {
    return reply.code(304).header('etag', etag).send();
  }
  const accept = String(request.headers['accept-encoding'] ?? '');
  let file = target;
  let encoding: string | null = null;
  if (accept.includes('br')) {
    try {
      await access(`${target}.br`, fsConstants.R_OK);
      file = `${target}.br`;
      encoding = 'br';
    } catch {
      // no brotli
    }
  }
  if (!encoding && accept.includes('gzip')) {
    try {
      await access(`${target}.gz`, fsConstants.R_OK);
      file = `${target}.gz`;
      encoding = 'gzip';
    } catch {
      // no gzip
    }
  }
  const fileInfo = file === target ? info : await stat(file);
  reply
    .header('content-type', MIME[ext] ?? 'application/octet-stream')
    .header('content-length', String(fileInfo.size))
    .header('etag', etag)
    .header('vary', 'Accept-Encoding')
    .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600')
    .header('x-content-type-options', 'nosniff');
  if (encoding) reply.header('content-encoding', encoding);
  if (request.method === 'HEAD') {
    return reply.send();
  }
  return reply.send(createReadStream(file));
}

export function registerPageRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  manifest: AssetManifest,
): void {
  app.get('/', async (request, reply) => {
    const result = listAlbums(db, request.role, undefined, 50);
    reply
      .header('cache-control', 'private, no-cache')
      .type('text/html; charset=utf-8')
      .send(
        renderHomePage({
          albums: result.albums,
          nextCursor: result.nextCursor,
          people: listPeople(db).map(personToDTO),
          role: request.role,
          authenticated: Boolean(request.auth),
          manifest,
        }),
      );
  });

  app.get('/a/:albumDir', async (request, reply) => {
    const { albumDir } = request.params as { albumDir: string };
    const album = requireVisibleAlbum(getAlbumByDir(db, albumDir), request.role);
    const sessionId = request.auth?.session.id ?? null;
    const photos = listPhotos(db, album, request.role, undefined, 60, sessionId);
    const albumPeople = listPeopleForAlbum(db, album.id).map(personToDTO);
    const permissions: PermissionsDTO = {
      canUpload: canUpload(request.role),
      canCreateAlbum: canCreateAlbum(request.role),
      canManageAlbum: canManageAlbum(request.role),
      canSetTier: canUpload(request.role),
      canSetVisibility: canSetVisibility(request.role),
    };
    reply
      .header('cache-control', 'private, no-cache')
      .type('text/html; charset=utf-8')
      .send(
        renderAlbumPage({
          album: {
            id: album.id,
            name: album.name,
            dir: album.dir_name,
            visibility: album.visibility,
            createdAt: album.created_at,
            photoCount: countVisiblePhotos(db, album.id, request.role),
            cover: null,
            people: albumPeople,
            canUpload: permissions.canUpload,
            canManage: permissions.canManageAlbum,
          },
          photos: photos.items,
          nextCursor: photos.nextCursor,
          allPeople: listPeople(db).map(personToDTO),
          permissions,
          role: request.role,
          authenticated: Boolean(request.auth),
          manifest,
        }),
      );
  });

  app.get('/upload', async (request, reply) => {
    if (!canUpload(request.role)) {
      reply
        .code(403)
        .header('cache-control', 'private, no-cache')
        .type('text/html; charset=utf-8')
        .send(
          renderLayout({
            title: '需要上传权限 · Kig Photo Space',
            body: `<div class="empty-state"><h1>需要上传权限</h1><p>请使用上传者或管理员密码登录后再上传照片。</p><button class="button primary" type="button" data-action="open-login">登录</button></div>`,
            role: request.role,
            authenticated: Boolean(request.auth),
            active: 'upload',
            assets: manifest.entry('main.ts'),
          }),
        );
      return;
    }
    const albums = listAlbumOptions(db, request.role).map((album) =>
      albumToDTO(album, null, 0, request.role),
    );
    const query = request.query as { album?: string };
    const selected = query.album ? Number(query.album) : null;
    reply
      .header('cache-control', 'private, no-cache')
      .type('text/html; charset=utf-8')
      .send(
        renderUploadPage({
          albums,
          role: request.role,
          authenticated: Boolean(request.auth),
          selectedAlbumId: Number.isSafeInteger(selected) && selected! > 0 ? selected : null,
          manifest,
        }),
      );
  });

  app.get('/admin', async (request, reply) => {
    if (request.role !== 'admin') {
      reply
        .code(404)
        .header('cache-control', 'private, no-cache')
        .type('text/html; charset=utf-8')
        .send(
          renderLayout({
            title: '页面不存在 · Kig Photo Space',
            body: `<div class="empty-state"><h1>页面不存在</h1><p><a href="/">返回首页</a></p></div>`,
            role: request.role,
            authenticated: Boolean(request.auth),
            assets: manifest.entry('main.ts'),
          }),
        );
      return;
    }
    reply
      .header('cache-control', 'private, no-cache')
      .type('text/html; charset=utf-8')
      .send(renderAdminPage({ role: request.role, authenticated: true, manifest }));
  });

  app.get('/login', async (_request, reply) => {
    reply
      .header('cache-control', 'private, no-cache')
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>登录 · Kig Photo Space</title><body style="font-family:system-ui,-apple-system,'PingFang SC',sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem;background:#0c0c0e;color:#f4f2ee"><h1>登录</h1><p style="color:#9b9791">输入访问密码。没有用户名。</p><form method="post" action="/login"><label>密码 <input type="password" name="password" autocomplete="current-password" minlength="8" maxlength="128" required autofocus style="display:block;width:100%;margin-top:.35rem;padding:.55rem .7rem;border:1px solid #2d2d32;border-radius:8px;background:#17171a;color:#f4f2ee"></label><p><button type="submit" style="padding:.55rem 1rem;border:1px solid #e6b98c;border-radius:999px;background:#e6b98c;color:#1a120a;font-weight:600;cursor:pointer">登录</button></p></form><p><a href="/" style="color:#e6b98c">返回首页</a></p></body></html>`,
      );
  });

  app.get('/healthz', async (_request, reply) => {
    let dbOk = false;
    try {
      db.get('SELECT 1 AS ok');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    let dataDirOk = false;
    try {
      await access(config.dataDir, fsConstants.W_OK);
      dataDirOk = true;
    } catch {
      dataDirOk = false;
    }
    const disk = await diskInfo(config);
    const ok = dbOk && dataDirOk;
    reply
      .code(ok ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ ok, db: dbOk, dataDir: dataDirOk, diskFree: disk.free, diskTotal: disk.total });
  });

  app.get('/robots.txt', async (_request, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600').send('User-agent: *\nDisallow: /\n');
  });

  app.get('/favicon.svg', async (_request, reply) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f2937"/><circle cx="32" cy="32" r="16" fill="none" stroke="#f9fafb" stroke-width="4"/><circle cx="32" cy="32" r="6" fill="#f9fafb"/></svg>`;
    reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(svg);
  });

  app.get('/assets/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'];
    return serveStatic(request, reply, join(config.publicDir, 'assets'), wildcard, true);
  });

  app.get('/wasm/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'];
    return serveStatic(request, reply, join(config.publicDir, 'wasm'), wildcard, true);
  });

  app.get('/favicon.ico', async (_request, reply) => {
    reply.code(204).send();
  });
}
