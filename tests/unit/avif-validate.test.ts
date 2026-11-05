import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bufferReader, validateAvif } from '../../src/shared/avif/parse.js';
import { AvifValidationError } from '../../src/shared/avif/types.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const fullOptions = {
  kind: 'full' as const,
  maxDimension: 12000,
  maxPixels: 80_000_000,
  maxBytes: 50 * 1024 * 1024,
};

const thumbOptions = {
  kind: 'thumb' as const,
  maxDimension: 12000,
  maxPixels: 80_000_000,
  maxBytes: 2 * 1024 * 1024,
};

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AvifValidationError);
    expect((error as AvifValidationError).code).toBe(code);
  }
}

describe('AVIF validation', () => {
  it('accepts a valid full image', async () => {
    const info = await validateAvif(bufferReader(fixture('sdr.avif')), fullOptions);
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    expect(info.bitDepth).toBe(8);
  });

  it('accepts a 600x600 thumbnail', async () => {
    const info = await validateAvif(bufferReader(fixture('thumb.avif')), thumbOptions);
    expect(info.width).toBe(600);
    expect(info.height).toBe(600);
    expect(info.chroma).toBe(420);
  });

  it('rejects a thumbnail with the wrong dimensions', async () => {
    await expectCode(validateAvif(bufferReader(fixture('thumb-wrong.avif')), thumbOptions), 'INVALID_THUMBNAIL');
  });

  it('rejects animation brands', async () => {
    const data = fixture('sdr.avif');
    data.set([0x61, 0x76, 0x69, 0x73], 8); // 'avis'
    await expectCode(validateAvif(bufferReader(data), fullOptions), 'UNSUPPORTED_FORMAT');
  });

  it('rejects trailing garbage', async () => {
    const data = fixture('sdr.avif');
    const withGarbage = new Uint8Array(data.byteLength + 3);
    withGarbage.set(data);
    withGarbage.set([1, 2, 3], data.byteLength);
    await expectCode(validateAvif(bufferReader(withGarbage), fullOptions), 'TRAILING_DATA');
  });

  it('rejects truncated files', async () => {
    const data = fixture('sdr.avif').slice(0, 200);
    await expectCode(validateAvif(bufferReader(data), fullOptions), 'INVALID_BOX');
  });

  it('rejects non-AVIF data', async () => {
    const data = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    await expectCode(validateAvif(bufferReader(data), fullOptions), 'INVALID_FTYP');
  });

  it('rejects files over the size limit', async () => {
    await expectCode(
      validateAvif(bufferReader(fixture('sdr.avif')), { ...fullOptions, maxBytes: 100 }),
      'FILE_TOO_LARGE',
    );
  });
});
