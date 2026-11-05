import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

let scryptChain: Promise<unknown> = Promise.resolve();

function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  const next = scryptChain.then(fn, fn);
  scryptChain = next.catch(() => undefined);
  return next;
}

export function passwordLookup(pepper: string, password: string): string {
  return createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await withScryptSlot(() =>
    scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM }),
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (expected.byteLength !== KEY_LEN) return false;
  const actual = await withScryptSlot(() =>
    scrypt(password, salt, expected.byteLength, { N: n, r, p, maxmem: MAXMEM }),
  );
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

let dummyHashPromise: Promise<string> | null = null;

export function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(24).toString('base64url'));
  }
  return dummyHashPromise;
}

export async function dummyVerify(password: string): Promise<void> {
  const stored = await dummyHash();
  await verifyPassword(password, stored);
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string') throw new Error('密码必须是字符串');
  if (password.length < 8 || password.length > 128) {
    throw new Error('密码长度必须在 8 到 128 个字符之间');
  }
  return password;
}

export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}
