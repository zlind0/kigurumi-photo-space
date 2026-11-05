import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(statusCode: number, code: string, message: string, expose = true) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

export function badRequest(message: string, code = 'BAD_REQUEST'): AppError {
  return new AppError(400, code, message);
}

export function unauthorized(message = '请先登录', code = 'AUTH_REQUIRED'): AppError {
  return new AppError(401, code, message);
}

export function forbidden(message = '没有权限', code = 'FORBIDDEN'): AppError {
  return new AppError(403, code, message);
}

export function notFound(message = '资源不存在'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

export function tooLarge(message = '文件过大'): AppError {
  return new AppError(413, 'FILE_TOO_LARGE', message);
}

export function unsupported(message = '不支持的格式'): AppError {
  return new AppError(415, 'UNSUPPORTED_FORMAT', message);
}

export function unprocessable(code: string, message: string): AppError {
  return new AppError(422, code, message);
}

export function rateLimited(message = '请求过于频繁，请稍后再试'): AppError {
  return new AppError(429, 'RATE_LIMITED', message);
}

export function quotaExceeded(message = '存储空间不足'): AppError {
  return new AppError(507, 'QUOTA_EXCEEDED', message);
}

export function isApiRequest(request: FastifyRequest): boolean {
  return request.url.startsWith('/api/') || request.url.startsWith('/healthz');
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    const requestId = randomUUID();
    const statusCode = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500);
    const code = error instanceof AppError ? error.code : statusCode === 413 ? 'FILE_TOO_LARGE' : 'INTERNAL';
    const message =
      error instanceof AppError
        ? error.message
        : statusCode >= 500
          ? '服务器内部错误'
          : error.message || '请求失败';
    if (statusCode >= 500) {
      request.log.error({ err: error, requestId }, 'request failed');
    }
    if (isApiRequest(request)) {
      reply
        .code(statusCode)
        .header('cache-control', 'private, no-store')
        .send({ error: { code, message, requestId } });
      return;
    }
    reply
      .code(statusCode)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${statusCode}</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${statusCode}</h1><p>${escapeHtml(message)}</p><p><a href="/">返回首页</a></p><p style="color:#888;font-size:.8rem">请求 ID: ${requestId}</p></body></html>`,
      );
  });
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AppError) {
    reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return;
  }
  reply.code(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
}
