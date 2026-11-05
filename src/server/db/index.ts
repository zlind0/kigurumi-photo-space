import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class Database {
  readonly raw: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA cache_size = -4000;
      PRAGMA temp_store = MEMORY;
    `);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string) {
    return this.raw.prepare(sql);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as never[])) as T[];
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const result = this.prepare(sql).run(...(params as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

function migrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

export function migrate(db: Database, config: Config): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const dir = migrationsDir();
  if (!existsSync(dir)) {
    throw new Error(`找不到数据库迁移目录: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((row) => row.version),
  );
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (!Number.isFinite(version) || applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const backupDir = join(config.dataDir, 'backups');
    mkdirSync(backupDir, { recursive: true, mode: 0o750 });
    const backupPath = join(backupDir, `pre-migrate-${version}.sqlite`);
    if (!existsSync(backupPath)) {
      try {
        db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      } catch {
        // A fresh database has nothing to back up; continue.
      }
    }
    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, Date.now());
    });
  }
}

export function openDatabase(config: Config): Database {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  const db = new Database(join(config.dataDir, 'db.sqlite'));
  migrate(db, config);
  return db;
}
