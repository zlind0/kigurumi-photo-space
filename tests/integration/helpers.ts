import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/server/config.js';
import { openDatabase, type Database } from '../../src/server/db/index.js';
import { buildApp } from '../../src/server/index.js';
import { AssetManifest } from '../../src/server/templates/layout.js';
import { hashPassword, passwordLookup } from '../../src/server/auth/password.js';

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  config: Config;
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'kps-test-'));
  const config = loadConfig({
    dataDir: dir,
    authPepper: 'test-pepper-0123456789abcdef0123456789abcdef',
    publicOrigin: 'http://localhost',
    cookieSecure: false,
    nodeEnv: 'test',
    isProduction: false,
    logLevel: 'silent',
    publicDir: join(dir, 'public'),
    manifestPath: join(dir, 'manifest.json'),
  });
  const db = openDatabase(config);
  const password = 'admin-password-123';
  const hash = await hashPassword(password);
  db.run(
    `INSERT INTO users (role, password_lookup, password_hash, created_at)
     VALUES ('admin', ?, ?, ?)`,
    passwordLookup(config.authPepper, password),
    hash,
    Date.now(),
  );
  const app = await buildApp(config, db, new AssetManifest(config.manifestPath));
  await app.ready();
  return {
    app,
    db,
    config,
    dir,
    cleanup: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface LoginResult {
  cookie: string;
  response: Awaited<ReturnType<FastifyInstance['inject']>>;
}

export async function login(app: FastifyInstance, password: string): Promise<LoginResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'fetch',
      origin: 'http://localhost',
    },
    payload: { password },
  });
  const cookie = response.cookies.find((entry) => entry.name === 'sid');
  return {
    cookie: cookie ? `sid=${cookie.value}` : '',
    response,
  };
}

export function authHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    'x-requested-with': 'fetch',
    origin: 'http://localhost',
  };
}

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export function multipart(
  fields: Record<string, string>,
  files: MultipartFile[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----kps${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
