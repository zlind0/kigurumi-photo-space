import type { AlbumRow } from './albums.js';

interface CacheEntry {
  album: AlbumRow | null;
  expires: number;
}

const TTL = 60_000;
const cache = new Map<string, CacheEntry>();

export function getCachedAlbum(dirName: string, loader: () => AlbumRow | null): AlbumRow | null {
  const now = Date.now();
  const cached = cache.get(dirName);
  if (cached && cached.expires > now) return cached.album;
  const album = loader();
  cache.set(dirName, { album, expires: now + TTL });
  if (cache.size > 2000) {
    for (const [key, entry] of cache) {
      if (entry.expires <= now) cache.delete(key);
    }
  }
  return album;
}

export function invalidateAlbum(dirName: string): void {
  cache.delete(dirName);
}

export function clearAlbumCache(): void {
  cache.clear();
}
