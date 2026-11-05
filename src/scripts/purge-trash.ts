import { loadConfig } from '../server/config.js';
import { purgeTrash } from '../server/services/storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const removed = await purgeTrash(config);
  console.log(`已清理 ${removed} 个回收站目录（保留 ${config.trashRetentionDays} 天）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
