import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bufferReader, parseIsobmff, validateAvif } from '../../src/shared/avif/parse.js';
import { injectExif, setTiffOrientation } from '../../src/shared/avif/write.js';

function makeTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  tiff[2] = 42;
  tiff[3] = 0;
  tiff[4] = 8;
  tiff[5] = 0;
  tiff[6] = 0;
  tiff[7] = 0;
  tiff[8] = 1;
  tiff[9] = 0;
  tiff[10] = 0x12;
  tiff[11] = 0x01;
  tiff[12] = 3;
  tiff[13] = 0;
  tiff[14] = 1;
  tiff[15] = 0;
  tiff[16] = 0;
  tiff[17] = 0;
  tiff[18] = orientation;
  tiff[19] = 0;
  return tiff;
}

describe('EXIF injection', () => {
  it('sets TIFF orientation to 1', () => {
    const tiff = makeTiff(6);
    const fixed = setTiffOrientation(tiff, 1);
    expect(fixed[18]).toBe(1);
    expect(tiff[18]).toBe(6);
  });

  it('injects an Exif item into an AVIF and keeps it decodable', async () => {
    const source = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../fixtures/sdr.avif', import.meta.url))),
    );
    const tiff = setTiffOrientation(makeTiff(6), 1);
    const out = await injectExif(source, tiff);
    writeFileSync('/tmp/kps-exif-test.avif', out);
    const file = await parseIsobmff(bufferReader(out));
    expect(file.meta?.items.some((item) => item.type === 'Exif')).toBe(true);
    expect(file.meta?.references.some((ref) => ref.type === 'cdsc')).toBe(true);
    const info = await validateAvif(bufferReader(out), {
      kind: 'full',
      maxDimension: 12000,
      maxPixels: 80_000_000,
      maxBytes: 50 * 1024 * 1024,
    });
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    expect(info.hasExif).toBe(true);
  });
});
