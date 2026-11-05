import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { AdminStats, AdminUserDTO, AuditLogDTO, UserRole } from '../../shared/types.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../shared/cursor.js';
import { generatePassword, hashPassword, passwordLookup, validatePassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/session.js';
import { assertSameOrigin } from '../http/csrf.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../http/errors.js';
import { audit } from '../services/audit.js';
import { diskInfo } from '../services/storage.js';

interface UserRow {
  id: number;
  role: UserRole;
  created_at: number;
  created_by: number | null;
  last_login_at: number | null;
  disabled: number;
  note: string | null;
}

function toUserDTO(row: UserRow): AdminUserDTO {
  return {
    id: row.id,
    role: row.role,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastLoginAt: row.last_login_at,
    disabled: row.disabled !== 0,
    note: row.note,
  };
}

function requireAdmin(role: string): void {
  if (role !== 'admin') throw forbidden('需要管理员权限');
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('用户不存在');
  return id;
}

function enabledAdminCount(db: Database): number {
  const row = db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0",
  );
  return row?.c ?? 0;
}

export function registerAdminRoutes(app: FastifyInstance, db: Database, config: Config): void {
  app.get('/api/admin/users', async (request, reply) => {
    requireAdmin(request.role);
    const rows = db.all<UserRow>(
      'SELECT id, role, created_at, created_by, last_login_at, disabled, note FROM users ORDER BY id ASC',
    );
    reply.header('cache-control', 'private, no-store');
    return { users: rows.map(toUserDTO) };
  });

  app.post('/api/admin/users', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const body = request.body as { role?: unknown; password?: unknown; note?: unknown } | null;
    const role = body?.role;
    if (role !== 'viewer' && role !== 'uploader' && role !== 'admin') {
      throw badRequest('role 必须是 viewer、uploader 或 admin');
    }
    let password: string;
    let generated = false;
    if (body?.password === undefined || body.password === '') {
      password = generatePassword();
      generated = true;
    } else {
      try {
        password = validatePassword(body.password);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : '密码不合法');
      }
    }
    const lookup = passwordLookup(config.authPepper, password);
    if (db.get('SELECT id FROM users WHERE password_lookup = ?', lookup)) {
      throw conflict('PASSWORD_TAKEN', '该密码已被其他用户使用，请换一个');
    }
    const hash = await hashPassword(password);
    const result = db.run(
      `INSERT INTO users (role, password_lookup, password_hash, created_at, created_by, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      role,
      lookup,
      hash,
      Date.now(),
      request.auth.user.id,
      typeof body?.note === 'string' ? body.note.slice(0, 200) : null,
    );
    const row = db.get<UserRow>(
      'SELECT id, role, created_at, created_by, last_login_at, disabled, note FROM users WHERE id = ?',
      result.lastInsertRowid,
    );
    if (!row) throw new AppError(500, 'INTERNAL', '创建用户失败');
    audit(db, {
      userId: request.auth.user.id,
      sessionId: request.auth.session.id,
      action: 'user.create',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      targetType: 'user',
      targetId: row.id,
      detail: { role },
    });
    reply.code(201).header('cache-control', 'private, no-store');
    return { user: toUserDTO(row), password: generated ? password : undefined };
  });

  app.patch('/api/admin/users/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const userId = parseId(id);
    const row = db.get<UserRow>(
      'SELECT id, role, created_at, created_by, last_login_at, disabled, note FROM users WHERE id = ?',
      userId,
    );
    if (!row) throw notFound('用户不存在');
    const body = request.body as { role?: unknown; password?: unknown; disabled?: unknown } | null;
    const nextRole = body?.role;
    const nextDisabled = body?.disabled;
    if (nextRole !== undefined && nextRole !== 'viewer' && nextRole !== 'uploader' && nextRole !== 'admin') {
      throw badRequest('role 不合法');
    }
    if (nextDisabled !== undefined && typeof nextDisabled !== 'boolean') {
      throw badRequest('disabled 必须是布尔值');
    }
    const demoting = row.role === 'admin' && nextRole !== undefined && nextRole !== 'admin';
    const disabling = row.role === 'admin' && nextDisabled === true && row.disabled === 0;
    if ((demoting || disabling) && enabledAdminCount(db) <= 1) {
      throw conflict('LAST_ADMIN', '不能降级或禁用最后一个管理员');
    }
    let newPassword: string | null = null;
    if (body?.password !== undefined && body.password !== '') {
      try {
        newPassword = validatePassword(body.password);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : '密码不合法');
      }
      const lookup = passwordLookup(config.authPepper, newPassword);
      const other = db.get<{ id: number }>('SELECT id FROM users WHERE password_lookup = ? AND id != ?', lookup, userId);
      if (other) throw conflict('PASSWORD_TAKEN', '该密码已被其他用户使用，请换一个');
      const hash = await hashPassword(newPassword);
      db.run('UPDATE users SET password_lookup = ?, password_hash = ? WHERE id = ?', lookup, hash, userId);
      deleteUserSessions(db, userId);
      audit(db, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        action: 'user.password_reset',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        targetType: 'user',
        targetId: userId,
      });
    }
    if (nextRole !== undefined) db.run('UPDATE users SET role = ? WHERE id = ?', nextRole, userId);
    if (nextDisabled !== undefined) {
      db.run('UPDATE users SET disabled = ? WHERE id = ?', nextDisabled ? 1 : 0, userId);
      if (nextDisabled) deleteUserSessions(db, userId);
    }
    if (nextRole !== undefined || nextDisabled !== undefined) {
      audit(db, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        action: 'user.update',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        targetType: 'user',
        targetId: userId,
        detail: { role: nextRole, disabled: nextDisabled },
      });
    }
    const updated = db.get<UserRow>(
      'SELECT id, role, created_at, created_by, last_login_at, disabled, note FROM users WHERE id = ?',
      userId,
    );
    reply.header('cache-control', 'private, no-store');
    return { user: updated ? toUserDTO(updated) : null, password: newPassword ?? undefined };
  });

  app.delete('/api/admin/users/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const userId = parseId(id);
    const row = db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row) throw notFound('用户不存在');
    if (row.role === 'admin' && row.disabled === 0 && enabledAdminCount(db) <= 1) {
      throw conflict('LAST_ADMIN', '不能删除最后一个管理员');
    }
    db.run('DELETE FROM users WHERE id = ?', userId);
    audit(db, {
      userId: request.auth.user.id,
      sessionId: request.auth.session.id,
      action: 'user.delete',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      targetType: 'user',
      targetId: userId,
      detail: { role: row.role },
    });
    reply.code(204).send();
  });

  app.get('/api/admin/logs', async (request, reply) => {
    requireAdmin(request.role);
    const query = request.query as {
      cursor?: string;
      limit?: string;
      action?: string;
      userId?: string;
      from?: string;
      to?: string;
    };
    const limit = clampLimit(query.limit, 50, 100);
    const cursor = decodeCursor(query.cursor);
    const params: unknown[] = [];
    let where = '1=1';
    if (query.action) {
      where += ' AND action = ?';
      params.push(query.action);
    }
    if (query.userId) {
      const userId = Number(query.userId);
      if (Number.isSafeInteger(userId) && userId > 0) {
        where += ' AND user_id = ?';
        params.push(userId);
      }
    }
    if (query.from) {
      const from = Date.parse(query.from);
      if (Number.isFinite(from)) {
        where += ' AND ts >= ?';
        params.push(from);
      }
    }
    if (query.to) {
      const to = Date.parse(query.to);
      if (Number.isFinite(to)) {
        where += ' AND ts <= ?';
        params.push(to + 86_399_999);
      }
    }
    if (cursor) {
      where += ' AND (ts < ? OR (ts = ? AND id < ?))';
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    params.push(limit + 1);
    const rows = db.all<{
      id: number;
      ts: number;
      user_id: number | null;
      role: UserRole | null;
      session_id: string | null;
      action: string;
      ip: string | null;
      user_agent: string | null;
      target_type: string | null;
      target_id: string | null;
      detail: string | null;
    }>(
      `SELECT l.*, u.role FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE ${where} ORDER BY l.ts DESC, l.id DESC LIMIT ?`,
      ...params,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const logs: AuditLogDTO[] = page.map((row) => ({
      id: row.id,
      ts: row.ts,
      userId: row.user_id,
      role: row.role,
      sessionId: row.session_id,
      action: row.action,
      ip: row.ip,
      userAgent: row.user_agent,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: row.detail ? safeJson(row.detail) : null,
    }));
    const last = page[page.length - 1];
    reply.header('cache-control', 'private, no-store');
    return {
      logs,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.ts, id: last.id }) : null,
    };
  });

  app.get('/api/admin/stats', async (request, reply) => {
    requireAdmin(request.role);
    const albums = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM albums WHERE deleted_at IS NULL')?.c ?? 0;
    const photos = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM photos WHERE deleted_at IS NULL')?.c ?? 0;
    const users = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0;
    const totalBytes =
      db.get<{ total: number }>(
        'SELECT COALESCE(SUM(size_bytes + thumb_size_bytes), 0) AS total FROM photos WHERE deleted_at IS NULL',
      )?.total ?? 0;
    const disk = await diskInfo(config);
    reply.header('cache-control', 'private, no-store');
    return {
      albums,
      photos,
      users,
      totalBytes,
      diskFree: disk.free,
      diskTotal: disk.total,
    } satisfies AdminStats;
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
