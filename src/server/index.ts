import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { openDatabase, type Database } from './db/index.js';
import { getSession } from './auth/session.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAlbumRoutes } from './routes/albums.js';
import { registerPhotoRoutes } from './routes/photos.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerPageRoutes } from './routes/pages.js';
import { AssetManifest } from './templates/layout.js';
import { cleanupSessions } from './auth/session.js';
import { cleanupAudit } from './services/audit.js';
import { cleanupTmp, ensureDataDirs, purgeTrash } from './services/storage.js';

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(
  config: Config,
  db: Database,
  manifest: AssetManifest,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.maxJsonBytes,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxFullBytes,
      files: 2,
      fields: 10,
      fieldSize: config.maxJsonBytes,
      parts: 12,
    },
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        done(null, Object.fromEntries(params.entries()));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[config.cookieName];
    request.auth = getSession(db, token, config);
    request.role = request.auth?.user.role ?? 'public';
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('x-frame-options', 'DENY');
    if (config.cookieSecure) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'private, no-store');
    }
    return payload;
  });

  registerErrorHandler(app);
  registerAuthRoutes(app, db, config);
  registerAlbumRoutes(app, db, config);
  registerPhotoRoutes(app, db, config);
  registerMediaRoutes(app, db, config);
  registerAdminRoutes(app, db, config);
  registerPeopleRoutes(app, db, config);
  registerPageRoutes(app, db, config, manifest);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>页面不存在</h1><p><a href="/">返回首页</a></p></body></html>`,
      );
  });

  return app;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  await ensureDataDirs(config);
  await cleanupTmp(config);
  cleanupSessions(db);
  await purgeTrash(config);
  cleanupAudit(db, config.auditRetentionDays);
  const manifest = new AssetManifest(config.manifestPath);
  const app = await buildApp(config, db, manifest);

  const hourly = setInterval(() => {
    try {
      cleanupSessions(db);
      void cleanupTmp(config);
    } catch (error) {
      app.log.error({ err: error }, 'hourly cleanup failed');
    }
  }, 3_600_000);
  hourly.unref();
  const daily = setInterval(() => {
    try {
      void purgeTrash(config);
      cleanupAudit(db, config.auditRetentionDays);
    } catch (error) {
      app.log.error({ err: error }, 'daily cleanup failed');
    }
  }, 86_400_000);
  daily.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(hourly);
    clearInterval(daily);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { dataDir: config.dataDir, publicOrigin: config.publicOrigin },
    'Kig Photo Space started',
  );
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
