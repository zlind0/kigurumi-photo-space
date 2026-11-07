import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  host: string;
  port: number;
  dataDir: string;
  publicOrigin: string;
  authPepper: string;
  cookieSecure: boolean;
  cookieName: string;
  sessionTtlMs: number;
  sessionMaxMs: number;
  maxFullBytes: number;
  maxThumbBytes: number;
  maxPreviewBytes: number;
  maxImageDimension: number;
  previewMaxDimension: number;
  maxImagePixels: number;
  maxUploadFiles: number;
  uploadConcurrency: number;
  maxTotalBytes: number;
  minFreeBytes: number;
  trashRetentionDays: number;
  auditRetentionDays: number;
  trustProxy: boolean;
  logLevel: string;
  maxAlbumsPerUser: number;
  maxPhotosPerAlbum: number;
  maxJsonBytes: number;
  maxAlbumNameLength: number;
  publicDir: string;
  manifestPath: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`环境变量 ${name} 必须是数字`);
  return Math.floor(n);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function loadPepper(dataDir: string, isProduction: boolean): string {
  const fromEnv = process.env.AUTH_PEPPER;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (isProduction) {
    throw new Error('生产环境必须设置 AUTH_PEPPER（至少 16 字符）');
  }
  const secretPath = join(dataDir, '.secret');
  if (existsSync(secretPath)) {
    const value = readFileSync(secretPath, 'utf8').trim();
    if (value.length >= 16) return value;
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as Config['nodeEnv'];
  const isProduction = nodeEnv === 'production';
  const dataDir = resolve(overrides.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), 'data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  const port = envInt('PORT', 3000);
  const publicOrigin = (process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const cookieSecure = envBool('COOKIE_SECURE', publicOrigin.startsWith('https://'));
  const config: Config = {
    nodeEnv,
    isProduction,
    host: process.env.HOST ?? '127.0.0.1',
    port,
    dataDir,
    publicOrigin,
    authPepper: loadPepper(dataDir, isProduction),
    cookieSecure,
    cookieName: cookieSecure ? '__Host-sid' : 'sid',
    sessionTtlMs: envInt('SESSION_TTL_DAYS', 7) * 86_400_000,
    sessionMaxMs: envInt('SESSION_MAX_DAYS', 30) * 86_400_000,
    maxFullBytes: envInt('MAX_FULL_BYTES', 50 * 1024 * 1024),
    maxThumbBytes: envInt('MAX_THUMB_BYTES', 2 * 1024 * 1024),
    maxPreviewBytes: envInt('MAX_PREVIEW_BYTES', 8 * 1024 * 1024),
    maxImageDimension: envInt('MAX_IMAGE_DIMENSION', 12000),
    previewMaxDimension: envInt('PREVIEW_MAX_DIMENSION', 3000),
    maxImagePixels: envInt('MAX_IMAGE_PIXELS', 80_000_000),
    maxUploadFiles: envInt('MAX_UPLOAD_FILES', 50),
    uploadConcurrency: envInt('UPLOAD_CONCURRENCY', 2),
    maxTotalBytes: envInt('MAX_TOTAL_BYTES', 20 * 1024 * 1024 * 1024),
    minFreeBytes: envInt('MIN_FREE_BYTES', 1024 * 1024 * 1024),
    trashRetentionDays: envInt('TRASH_RETENTION_DAYS', 7),
    auditRetentionDays: envInt('AUDIT_RETENTION_DAYS', 180),
    trustProxy: envBool('TRUST_PROXY', false),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    maxAlbumsPerUser: envInt('MAX_ALBUMS_PER_USER', 200),
    maxPhotosPerAlbum: envInt('MAX_PHOTOS_PER_ALBUM', 5000),
    maxJsonBytes: envInt('MAX_JSON_BYTES', 64 * 1024),
    maxAlbumNameLength: 80,
    publicDir: resolve(process.env.PUBLIC_DIR ?? join(process.cwd(), 'dist/public')),
    manifestPath: resolve(process.env.MANIFEST_PATH ?? join(process.cwd(), 'dist/public/.vite/manifest.json')),
    ...overrides,
  };
  return config;
}
