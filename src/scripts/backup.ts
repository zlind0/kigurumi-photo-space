import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/index.js';

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config);
  const dir = join(config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(dir, `db-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`数据库备份已写入 ${target}`);
  db.close();
}

main();
