import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { MeDTO, UserRole } from '../../shared/types.js';
import { dummyVerify, passwordLookup, verifyPassword } from '../auth/password.js';
import {
  cookieOptions,
  createSession,
  deleteSession,
  getSession,
} from '../auth/session.js';
import { AppError, badRequest, rateLimited, unauthorized } from '../http/errors.js';
import { assertSameOrigin } from '../http/csrf.js';
import { SlidingWindowLimiter } from '../http/rate-limit.js';
import { audit } from '../services/audit.js';

interface UserRow {
  id: number;
  role: UserRole;
  password_lookup: string;
  password_hash: string;
  disabled: number;
}

export function meFromRequest(request: FastifyRequest): MeDTO {
  if (!request.auth) return { authenticated: false, user: null, session: null };
  return {
    authenticated: true,
    user: { id: request.auth.user.id, role: request.auth.user.role },
    session: { expiresAt: request.auth.session.expiresAt },
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
): void {
  const perIpMinute = new SlidingWindowLimiter(10, 60_000);
  const perIpHour = new SlidingWindowLimiter(100, 3_600_000);
  const globalMinute = new SlidingWindowLimiter(100, 60_000);

  async function login(
    request: FastifyRequest,
    password: string,
    ip: string,
    userAgent: string | null,
  ): Promise<{ token: string; expiresAt: number; role: UserRole; userId: number }> {
    const lookup = passwordLookup(config.authPepper, password);
    const user = db.get<UserRow>('SELECT * FROM users WHERE password_lookup = ?', lookup);
    if (!user) {
      await dummyVerify(password);
      audit(db, {
        action: 'login.failure',
        ip,
        userAgent,
        detail: { reason: 'unknown' },
      });
      throw unauthorized('密码错误', 'INVALID_PASSWORD');
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      audit(db, {
        userId: user.id,
        action: 'login.failure',
        ip,
        userAgent,
        detail: { reason: 'bad_password' },
      });
      throw unauthorized('密码错误', 'INVALID_PASSWORD');
    }
    if (user.disabled !== 0) {
      audit(db, {
        userId: user.id,
        action: 'login.failure',
        ip,
        userAgent,
        detail: { reason: 'disabled' },
      });
      throw unauthorized('密码错误', 'INVALID_PASSWORD');
    }
    const oldToken = request.cookies[config.cookieName];
    if (oldToken) {
      const old = getSession(db, oldToken, config);
      if (old) deleteSession(db, old.session.id);
    }
    const { token, session } = createSession(db, user.id, ip, userAgent, config);
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
    audit(db, {
      userId: user.id,
      sessionId: session.id,
      action: 'login.success',
      ip,
      userAgent,
    });
    return { token, expiresAt: session.expiresAt, role: user.role, userId: user.id };
  }

  app.post('/api/login', async (request, reply) => {
    assertSameOrigin(request, config);
    const ip = request.ip;
    const minute = perIpMinute.hit(ip);
    const hour = perIpHour.hit(ip);
    const global = globalMinute.hit('global');
    if (!minute.allowed || !hour.allowed || !global.allowed) {
      const retry = Math.max(minute.retryAfterMs, hour.retryAfterMs, global.retryAfterMs);
      reply.header('retry-after', Math.ceil(retry / 1000));
      throw rateLimited('登录尝试过于频繁，请稍后再试');
    }
    const body = request.body as { password?: unknown } | null;
    if (!body || typeof body.password !== 'string') throw badRequest('请输入密码');
    const password = body.password;
    if (password.length < 8 || password.length > 128) {
      throw unauthorized('密码错误', 'INVALID_PASSWORD');
    }
    const result = await login(request, password, ip, request.headers['user-agent'] ?? null);
    reply.setCookie(config.cookieName, result.token, cookieOptions(config));
    reply.header('cache-control', 'private, no-store');
    return {
      authenticated: true,
      user: { id: result.userId, role: result.role },
      session: { expiresAt: result.expiresAt },
    } satisfies MeDTO;
  });

  app.post('/api/logout', async (request, reply) => {
    assertSameOrigin(request, config);
    if (request.auth) {
      deleteSession(db, request.auth.session.id);
      audit(db, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        action: 'logout',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    reply.clearCookie(config.cookieName, { path: '/' });
    reply.header('cache-control', 'private, no-store');
    return { ok: true };
  });

  app.get('/api/me', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return meFromRequest(request);
  });

  app.post('/login', async (request, reply) => {
    const body = request.body as { password?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    try {
      if (password.length < 8 || password.length > 128) {
        throw unauthorized('密码错误', 'INVALID_PASSWORD');
      }
      const result = await login(request, password, request.ip, request.headers['user-agent'] ?? null);
      reply.setCookie(config.cookieName, result.token, cookieOptions(config));
      return reply.redirect('/', 303);
    } catch (error) {
      const message = error instanceof AppError ? error.message : '登录失败';
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><body style="font-family:system-ui;max-width:24rem;margin:4rem auto;padding:0 1rem"><h1>登录</h1><p style="color:#b00">${message}</p><form method="post" action="/login"><label>密码 <input type="password" name="password" autocomplete="current-password" required autofocus></label><p><button type="submit">登录</button></p></form><p><a href="/">返回首页</a></p></body></html>`,
        );
    }
  });
}
