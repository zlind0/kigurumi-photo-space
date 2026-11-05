import { describe, expect, it } from 'vitest';
import { sanitizeAlbumName } from '../../src/server/services/albums.js';

describe('sanitizeAlbumName', () => {
  it('keeps Chinese names and spaces', () => {
    const result = sanitizeAlbumName('2026 春');
    expect(result.name).toBe('2026 春');
    expect(result.dirName).toBe('2026 春');
    expect(result.dirKey).toBe('2026 春');
  });

  it('trims and normalizes whitespace', () => {
    const result = sanitizeAlbumName('  Hello   World  ');
    expect(result.name).toBe('Hello   World');
    expect(result.dirName).toBe('Hello World');
  });

  it('replaces path separators and traversal', () => {
    const result = sanitizeAlbumName('a/b\\c..d');
    expect(result.dirName).not.toContain('/');
    expect(result.dirName).not.toContain('\\');
    expect(result.dirName).not.toContain('..');
  });

  it('prefixes reserved directory names', () => {
    expect(sanitizeAlbumName('tmp').dirName).toBe('_tmp');
    expect(sanitizeAlbumName('hidden').dirName).toBe('_hidden');
    expect(sanitizeAlbumName('db.sqlite').dirName).toBe('_db.sqlite');
  });

  it('rejects empty and dot-only names', () => {
    expect(() => sanitizeAlbumName('')).toThrow();
    expect(() => sanitizeAlbumName('   ')).toThrow();
    expect(() => sanitizeAlbumName('...')).toThrow();
  });

  it('rejects names longer than the limit', () => {
    expect(() => sanitizeAlbumName('a'.repeat(81))).toThrow();
  });

  it('produces case-insensitive dir keys', () => {
    expect(sanitizeAlbumName('ABC').dirKey).toBe(sanitizeAlbumName('abc').dirKey);
  });

  it('strips control characters', () => {
    const result = sanitizeAlbumName('a\u0000b\u001fc');
    expect(result.name).toBe('abc');
  });
});
