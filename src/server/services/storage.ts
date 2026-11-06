import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';
import type { Tier, Visibility } from '../../shared/types.js';
import { tierDirectory } from '../auth/permissions.js';

export interface PhotoFileRef {
  albumDir: string;
  md5: string;
  thumbMd5: string;
  tier: Tier;
  visibility: Visibility;
}

export function albumPath(config: Config, albumDir: string): string {
  const root = resolve(config.dataDir);
  const target = resolve(root, albumDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('相册路径越界');
  }
  return target;
}

export function tierPath(config: Config, albumDir: string, tier: Tier, visibility: Visibility): string {
  return join(albumPath(config, albumDir), tierDirectory(tier, visibility));
}

export function fullPath(config: Config, ref: PhotoFileRef): string {
  return join(tierPath(config, ref.albumDir, ref.tier, ref.visibility), `${ref.md5}.avif`);
}

export function thumbPath(config: Config, ref: PhotoFileRef): string {
  return join(tierPath(config, ref.albumDir, ref.tier, ref.visibility), `${ref.md5}.thumb.avif`);
}

export function coverPath(config: Config, albumDir: string): string {
  return join(albumPath(config, albumDir), 'cover.avif');
}

export function coverThumbPath(config: Config, albumDir: string): string {
  return join(albumPath(config, albumDir), 'cover.thumb.avif');
}

export function peopleDir(config: Config): string {
  return join(config.dataDir, 'people');
}

export function personAvatarPath(config: Config, md5: string): string {
  return join(peopleDir(config), `${md5}.avif`);
}

export function tmpDir(config: Config): string {
  return join(config.dataDir, 'tmp');
}

export function trashDir(config: Config): string {
  return join(config.dataDir, '.trash');
}

export async function ensureDataDirs(config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o750 });
  await mkdir(tmpDir(config), { recursive: true, mode: 0o750 });
  await mkdir(trashDir(config), { recursive: true, mode: 0o750 });
  await mkdir(peopleDir(config), { recursive: true, mode: 0o750 });
  await mkdir(join(config.dataDir, 'backups'), { recursive: true, mode: 0o750 });
}

export async function ensureAlbumDirs(config: Config, albumDir: string): Promise<void> {
  const root = albumPath(config, albumDir);
  await mkdir(root, { recursive: true, mode: 0o750 });
  for (const sub of ['top', 'others', 'hidden']) {
    await mkdir(join(root, sub), { recursive: true, mode: 0o750 });
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
  }
}

export async function atomicLink(source: string, target: string): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await link(source, temp);
  } catch {
    await copyFile(source, temp, fsConstants.COPYFILE_FICLONE);
  }
  await rename(temp, target);
}

export async function placeFile(
  config: Config,
  tmpPath: string,
  targetPath: string,
  existingSource: string | null,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o750 });
  if (await fileExists(targetPath)) {
    await rm(tmpPath, { force: true });
    return;
  }
  if (existingSource && (await fileExists(existingSource))) {
    await linkOrCopy(existingSource, targetPath);
    await rm(tmpPath, { force: true });
    return;
  }
  await rename(tmpPath, targetPath);
}

export async function movePhotoFiles(
  config: Config,
  from: PhotoFileRef,
  to: PhotoFileRef,
): Promise<void> {
  const fromFull = fullPath(config, from);
  const fromThumb = thumbPath(config, from);
  const toFull = fullPath(config, to);
  const toThumb = thumbPath(config, to);
  if (fromFull === toFull) return;
  await mkdir(dirname(toFull), { recursive: true, mode: 0o750 });
  for (const [source, target] of [
    [fromFull, toFull],
    [fromThumb, toThumb],
  ] as const) {
    if (!(await fileExists(source))) continue;
    if (await fileExists(target)) {
      await rm(source, { force: true });
    } else {
      await rename(source, target);
    }
  }
}

export async function removePhotoFiles(config: Config, ref: PhotoFileRef): Promise<void> {
  await rm(fullPath(config, ref), { force: true });
  await rm(thumbPath(config, ref), { force: true });
}

export async function updateCoverLinks(
  config: Config,
  albumDir: string,
  ref: PhotoFileRef | null,
): Promise<void> {
  const cover = coverPath(config, albumDir);
  const coverThumb = coverThumbPath(config, albumDir);
  if (!ref) {
    await rm(cover, { force: true });
    await rm(coverThumb, { force: true });
    return;
  }
  const full = fullPath(config, ref);
  const thumb = thumbPath(config, ref);
  if (await fileExists(full)) await atomicLink(full, cover);
  if (await fileExists(thumb)) await atomicLink(thumb, coverThumb);
}

export async function renameAlbumDir(config: Config, fromDir: string, toDir: string): Promise<void> {
  const from = albumPath(config, fromDir);
  const to = albumPath(config, toDir);
  if (from === to) return;
  if (await fileExists(to)) throw new Error('目标相册目录已存在');
  if (!(await fileExists(from))) {
    await ensureAlbumDirs(config, toDir);
    return;
  }
  await rename(from, to);
}

export async function deleteAlbumToTrash(config: Config, albumDir: string): Promise<void> {
  const source = albumPath(config, albumDir);
  if (!(await fileExists(source))) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(trashDir(config), `${stamp}-${albumDir}`);
  await mkdir(trashDir(config), { recursive: true, mode: 0o750 });
  await rename(source, target);
}

export async function cleanupTmp(config: Config, maxAgeMs = 3_600_000): Promise<number> {
  const dir = tmpDir(config);
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(path, { force: true });
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

export async function purgeTrash(config: Config): Promise<number> {
  const dir = trashDir(config);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - config.trashRetentionDays * 86_400_000;
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

export interface DiskInfo {
  free: number;
  total: number;
}

export async function diskInfo(config: Config): Promise<DiskInfo> {
  try {
    const info = await statfs(config.dataDir);
    return {
      free: Number(info.bavail) * Number(info.bsize),
      total: Number(info.blocks) * Number(info.bsize),
    };
  } catch {
    return { free: 0, total: 0 };
  }
}

export async function createTempFile(config: Config): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  await mkdir(tmpDir(config), { recursive: true, mode: 0o750 });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.part`;
  const path = join(tmpDir(config), name);
  const handle = await open(path, 'wx', 0o600);
  return { path, handle };
}

export async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
