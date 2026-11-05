import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const source = join(process.cwd(), 'src/server/db/migrations');
const target = join(process.cwd(), 'dist/server/db/migrations');
if (existsSync(source)) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`copied migrations -> ${target}`);
}
