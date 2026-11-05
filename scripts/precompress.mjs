import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const root = join(process.cwd(), 'dist/public');
const extensions = new Set(['.js', '.mjs', '.css', '.wasm', '.svg', '.json', '.html']);

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!extensions.has(extname(entry.name))) continue;
    const info = await stat(path);
    const source = await readFile(path);
    const brotliPath = `${path}.br`;
    const gzipPath = `${path}.gz`;
    let needsBrotli = true;
    let needsGzip = true;
    try {
      needsBrotli = (await stat(brotliPath)).mtimeMs < info.mtimeMs;
    } catch {}
    try {
      needsGzip = (await stat(gzipPath)).mtimeMs < info.mtimeMs;
    } catch {}
    if (needsBrotli) {
      await writeFile(
        brotliPath,
        brotliCompressSync(source, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
          },
        }),
      );
    }
    if (needsGzip) {
      await writeFile(gzipPath, gzipSync(source, { level: 9 }));
    }
  }
}

await walk(root);
console.log('precompressed assets written');
