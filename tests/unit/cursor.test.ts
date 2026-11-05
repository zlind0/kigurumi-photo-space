import { describe, expect, it } from 'vitest';
import { clampLimit, decodeCursor, encodeCursor } from '../../src/shared/cursor.js';

describe('cursor', () => {
  it('round-trips a cursor', () => {
    const cursor = { createdAt: 1760000000000, id: 42 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects invalid cursors', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64')).toBeNull();
    expect(decodeCursor(Buffer.from('abc:def').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('1:2:3').toString('base64url'))).toBeNull();
  });

  it('clamps limits', () => {
    expect(clampLimit(undefined, 50, 100)).toBe(50);
    expect(clampLimit('10', 50, 100)).toBe(10);
    expect(clampLimit('1000', 50, 100)).toBe(100);
    expect(clampLimit('0', 50, 100)).toBe(50);
    expect(clampLimit('-5', 50, 100)).toBe(50);
    expect(clampLimit('abc', 50, 100)).toBe(50);
  });
});
