import type { Database } from '../db/index.js';

export interface AuditInput {
  userId?: number | null;
  sessionId?: string | null;
  action: string;
  ip?: string | null;
  userAgent?: string | null;
  targetType?: string | null;
  targetId?: string | number | null;
  detail?: unknown;
}

export function audit(db: Database, input: AuditInput): void {
  try {
    db.run(
      `INSERT INTO audit_log (ts, user_id, session_id, action, ip, user_agent, target_type, target_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      input.userId ?? null,
      input.sessionId ?? null,
      input.action,
      input.ip ?? null,
      input.userAgent ? input.userAgent.slice(0, 300) : null,
      input.targetType ?? null,
      input.targetId === undefined || input.targetId === null ? null : String(input.targetId),
      input.detail === undefined ? null : JSON.stringify(input.detail),
    );
  } catch {
    // Audit failures must never break the request.
  }
}

export function cleanupAudit(db: Database, retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  return db.run('DELETE FROM audit_log WHERE ts < ?', cutoff).changes;
}
