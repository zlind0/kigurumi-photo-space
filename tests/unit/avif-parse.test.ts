import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bufferReader, parseIsobmff, validateAvif } from '../../src/shared/avif/parse.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

describe('AVIF parser', () => {
  it('parses an 8-bit AVIF', async () => {
    const data = fixture('sdr.avif');
    const file = await parseIsobmff(bufferReader(data));
    expect(file.ftyp?.compatibleBrands).toContain('avif');
    expect(file.meta?.primaryItemId).toBeTypeOf('number');
    const info = await validateAvif(bufferReader(data), {
      kind: 'full',
      maxDimension: 12000,
      maxPixels: 80_000_000,
      maxBytes: 50 * 1024 * 1024,
    });
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    expect(info.bitDepth).toBe(8);
    expect(info.chroma).toBe(420);
    expect(info.isHdr).toBe(false);
  });

  it('detects 10-bit HDR AVIF', async () => {
    const data = fixture('hdr.avif');
    const info = await validateAvif(bufferReader(data), {
      kind: 'full',
      maxDimension: 12000,
      maxPixels: 80_000_000,
      maxBytes: 50 * 1024 * 1024,
    });
    expect(info.bitDepth).toBe(10);
    expect(info.isHdr).toBe(true);
  });

  it('rejects non-AVIF data', async () => {
    const data = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    await expect(
      validateAvif(bufferReader(data), {
        kind: 'full',
        maxDimension: 12000,
        maxPixels: 80_000_000,
        maxBytes: 50 * 1024 * 1024,
      }),
    ).rejects.toThrow();
  });
});
