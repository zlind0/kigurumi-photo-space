import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { AppError } from './errors.js';

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function assertSameOrigin(request: FastifyRequest, config: Config): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = request.headers.origin;
  const expected = originOf(config.publicOrigin);
  if (origin) {
    if (!expected || originOf(origin) !== expected) {
      throw new AppError(403, 'CSRF', '请求来源不合法');
    }
  } else {
    const referer = request.headers.referer;
    if (referer) {
      if (!expected || originOf(referer) !== expected) {
        throw new AppError(403, 'CSRF', '请求来源不合法');
      }
    } else if (config.isProduction) {
      throw new AppError(403, 'CSRF', '缺少来源信息');
    }
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new AppError(403, 'CSRF', '跨站请求被拒绝');
  }
  const requestedWith = request.headers['x-requested-with'];
  if (requestedWith !== 'fetch' && !request.url.startsWith('/api/login')) {
    throw new AppError(403, 'CSRF', '缺少请求标记');
  }
}
