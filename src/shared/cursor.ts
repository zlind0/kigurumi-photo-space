export interface Cursor {
  createdAt: number;
  id: number;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}:${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  if (raw.length > 128) return null;
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(\d{1,16}):(\d{1,16})$/.exec(text);
  if (!match) return null;
  const createdAt = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(id)) return null;
  if (createdAt < 0 || id < 0) return null;
  return { createdAt, id };
}

export function clampLimit(raw: unknown, fallback = 50, max = 100): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
