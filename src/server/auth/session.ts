import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { UserRole } from '../../shared/types.js';

export interface SessionUser {
  id: number;
  role: UserRole;
  disabled: boolean;
}

export interface SessionRecord {
  id: string;
  userId: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AuthContext {
  session: SessionRecord;
  user: SessionUser;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSession(
  db: Database,
  userId: number,
  ip: string | null,
  userAgent: string | null,
  config: Config,
): { token: string; session: SessionRecord } {
  const token = randomBytes(32).toString('base64url');
  const id = hashToken(token);
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;
  db.run(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    now,
    now,
    expiresAt,
    ip,
    userAgent,
  );
  return {
    token,
    session: { id, userId, createdAt: now, lastSeenAt: now, expiresAt },
  };
}

export function getSession(db: Database, token: string | undefined, config: Config): AuthContext | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const id = hashToken(token);
  const row = db.get<{
    id: string;
    user_id: number;
    created_at: number;
    last_seen_at: number;
    expires_at: number;
    role: UserRole;
    disabled: number;
  }>(
    `SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, u.role, u.disabled
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    id,
  );
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now || row.disabled !== 0) {
    db.run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  const absoluteMax = row.created_at + config.sessionMaxMs;
  let expiresAt = row.expires_at;
  if (now - row.last_seen_at > 3_600_000) {
    expiresAt = Math.min(now + config.sessionTtlMs, absoluteMax);
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, expiresAt, id);
  }
  return {
    session: {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      lastSeenAt: now,
      expiresAt,
    },
    user: { id: row.user_id, role: row.role, disabled: row.disabled !== 0 },
  };
}

export function deleteSession(db: Database, sessionId: string): void {
  db.run('DELETE FROM sessions WHERE id = ?', sessionId);
}

export function deleteUserSessions(db: Database, userId: number): void {
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function cleanupSessions(db: Database): number {
  return db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now()).changes;
}

export function cookieOptions(config: Config): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  };
}
