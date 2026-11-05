import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import createAvifHdrEncoder from '../../src/client/wasm/avif_hdr_enc.js';
import { findSequenceHeader, parseObus, parseSequenceHeader } from '../../src/shared/avif/obu.js';
import { buildAvif } from '../../src/shared/avif/write.js';
import { bufferReader, validateAvif } from '../../src/shared/avif/parse.js';

describe('10-bit HDR AVIF encoder', () => {
  it('encodes a 10-bit AVIF that the parser accepts', async () => {
    const width = 320;
    const height = 240;
    const module = await createAvifHdrEncoder();
    const rgba = new Uint16Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = Math.round((x / (width - 1)) * 1023);
        rgba[i + 1] = Math.round((y / (height - 1)) * 1023);
        rgba[i + 2] = 512;
        rgba[i + 3] = 1023;
      }
    }
    const ptr = module._malloc(rgba.byteLength);
    module.HEAPU16.set(rgba, ptr >> 1);
    const outPtrPtr = module._malloc(4);
    const outSizePtr = module._malloc(4);
    const rc = module._kps_encode_av1_10bit(ptr, width, height, 60, 8, 9, 16, 9, outPtrPtr, outSizePtr);
    expect(rc).toBe(0);
    const outPtr = new DataView(module.HEAPU8.buffer).getUint32(outPtrPtr, true);
    const outSize = new DataView(module.HEAPU8.buffer).getUint32(outSizePtr, true);
    const encoded = module.HEAPU8.slice(outPtr, outPtr + outSize);
    module._kps_free(outPtr);
    module._free(ptr);
    module._free(outPtrPtr);
    module._free(outSizePtr);

    const obus = parseObus(encoded);
    const seq = findSequenceHeader(obus);
    expect(seq).not.toBeNull();
    const seqInfo = parseSequenceHeader(seq!.payload);
    const frame = encoded;
    const avif = buildAvif({
      width,
      height,
      bitDepth: 10,
      chroma: 420,
      av1c: {
        seqProfile: seqInfo.seqProfile,
        seqLevelIdx0: seqInfo.seqLevelIdx0,
        seqTier0: seqInfo.seqTier0,
        highBitdepth: true,
        twelveBit: false,
        monochrome: false,
        chromaSubsamplingX: true,
        chromaSubsamplingY: true,
        chromaSamplePosition: 0,
        configObus: seq!.raw,
      },
      frameData: frame,
      color: { primaries: 9, transfer: 16, matrix: 9, fullRange: true },
      clli: { maxContentLightLevel: 1000, maxPicAverageLightLevel: 400 },
    });
    writeFileSync('/tmp/kps-hdr-test.avif', avif);
    const info = await validateAvif(bufferReader(avif), {
      kind: 'full',
      maxDimension: 12000,
      maxPixels: 80_000_000,
      maxBytes: 50 * 1024 * 1024,
    });
    expect(info.width).toBe(width);
    expect(info.height).toBe(height);
    expect(info.bitDepth).toBe(10);
    expect(info.isHdr).toBe(true);
    expect(info.color?.transfer).toBe(16);
  });
});
