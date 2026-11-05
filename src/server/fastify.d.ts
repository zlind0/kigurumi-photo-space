import type { AuthContext } from './auth/session.js';
import type { Role } from '../shared/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    role: Role;
  }
}
