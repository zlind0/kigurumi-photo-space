import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/index.js';
import { albumPath, coverPath, coverThumbPath, fullPath, thumbPath } from '../server/services/storage.js';
import type { AlbumRow, PhotoRow } from '../server/services/albums.js';

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');
  const config = loadConfig();
  const db = openDatabase(config);
  const albums = db.all<AlbumRow>('SELECT * FROM albums WHERE deleted_at IS NULL');
  const photos = db.all<PhotoRow>('SELECT * FROM photos WHERE deleted_at IS NULL');
  const expected = new Set<string>();
  const missing: string[] = [];
  for (const photo of photos) {
    const album = albums.find((a) => a.id === photo.album_id);
    if (!album) continue;
    const ref = {
      albumDir: album.dir_name,
      md5: photo.md5,
      thumbMd5: photo.thumb_md5,
      tier: photo.tier,
      visibility: photo.visibility,
    };
    for (const path of [fullPath(config, ref), thumbPath(config, ref)]) {
      expected.add(path);
      try {
        await stat(path);
      } catch {
        missing.push(path);
      }
    }
  }
  for (const album of albums) {
    for (const path of [coverPath(config, album.dir_name), coverThumbPath(config, album.dir_name)]) {
      expected.add(path);
    }
  }
  const orphans: string[] = [];
  for (const album of albums) {
    const root = albumPath(config, album.dir_name);
    for (const sub of ['top', 'others', 'hidden']) {
      const dir = join(root, sub);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^[a-f0-9]{32}(\.thumb)?\.avif$/.test(entry)) continue;
        const path = join(dir, entry);
        if (!expected.has(path)) orphans.push(path);
      }
    }
  }
  console.log(`相册: ${albums.length}，照片: ${photos.length}`);
  console.log(`缺失文件: ${missing.length}`);
  for (const path of missing) console.log(`  MISSING ${path}`);
  console.log(`孤儿文件: ${orphans.length}`);
  for (const path of orphans) console.log(`  ORPHAN ${path}`);
  if (fix) {
    for (const path of orphans) {
      await rm(path, { force: true });
    }
    console.log(`已删除 ${orphans.length} 个孤儿文件`);
  } else if (orphans.length > 0) {
    console.log('使用 --fix 删除孤儿文件。');
  }
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
