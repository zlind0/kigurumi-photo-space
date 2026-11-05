import { init as initAvifEncode, encode as encodeAvifWasm } from '@phenomen/libavif-wasm/encode';
import createAvifHdrEncoder, { type AvifHdrEncoderModule } from '../wasm/avif_hdr_enc.js';
import { findSequenceHeader, parseObus, parseSequenceHeader } from '../../shared/avif/obu.js';
import { buildAvif } from '../../shared/avif/write.js';

let avifEncodeReady: Promise<void> | null = null;

async function ensureAvifEncode(): Promise<void> {
  if (!avifEncodeReady) avifEncodeReady = initAvifEncode();
  await avifEncodeReady;
}

export async function encodeSdr(
  imageData: ImageData,
  quality: number,
  speed: number,
): Promise<Uint8Array> {
  await ensureAvifEncode();
  const result = await encodeAvifWasm(
    { data: imageData.data, width: imageData.width, height: imageData.height },
    { quality, speed, subsample: 420 },
  );
  return new Uint8Array(result);
}

let hdrModulePromise: Promise<AvifHdrEncoderModule> | null = null;

async function loadHdrEncoder(): Promise<AvifHdrEncoderModule> {
  if (!hdrModulePromise) hdrModulePromise = createAvifHdrEncoder();
  return hdrModulePromise;
}

export interface HdrEncodeOptions {
  width: number;
  height: number;
  quality: number;
  speed: number;
  transfer: number;
  primaries?: number;
  matrix?: number;
  exifTiff?: Uint8Array | null;
}

export async function encodeHdr10(
  rgba10: Uint16Array,
  options: HdrEncodeOptions,
): Promise<Uint8Array> {
  const module = await loadHdrEncoder();
  const { width, height } = options;
  const inputBytes = rgba10.byteLength;
  const inputPtr = module._malloc(inputBytes);
  if (!inputPtr) throw new Error('HDR 编码器内存不足');
  const outPtrPtr = module._malloc(4);
  const outSizePtr = module._malloc(4);
  if (!outPtrPtr || !outSizePtr) {
    module._free(inputPtr);
    throw new Error('HDR 编码器内存不足');
  }
  try {
    module.HEAPU16.set(rgba10, inputPtr >> 1);
    const rc = module._kps_encode_av1_10bit(
      inputPtr,
      width,
      height,
      options.quality,
      options.speed,
      options.primaries ?? 9,
      options.transfer,
      options.matrix ?? 9,
      outPtrPtr,
      outSizePtr,
    );
    if (rc !== 0) throw new Error(`HDR 编码失败（错误码 ${rc}）`);
    const view = new DataView(module.HEAPU8.buffer);
    const outPtr = view.getUint32(outPtrPtr, true);
    const outSize = view.getUint32(outSizePtr, true);
    if (!outPtr || !outSize) throw new Error('HDR 编码器没有返回数据');
    const encoded = module.HEAPU8.slice(outPtr, outPtr + outSize);
    module._kps_free(outPtr);

    const obus = parseObus(encoded);
    const sequence = findSequenceHeader(obus);
    if (!sequence) throw new Error('HDR 编码结果缺少序列头');
    const sequenceInfo = parseSequenceHeader(sequence.payload);
    // Keep the sequence header in the item data as well as in av1C. Some
    // decoders (including ffmpeg's AVIF demuxer) expect it in the bitstream.
    const frame = encoded;
    return buildAvif({
      width,
      height,
      bitDepth: 10,
      chroma: 420,
      av1c: {
        seqProfile: sequenceInfo.seqProfile,
        seqLevelIdx0: sequenceInfo.seqLevelIdx0,
        seqTier0: sequenceInfo.seqTier0,
        highBitdepth: true,
        twelveBit: false,
        monochrome: false,
        chromaSubsamplingX: true,
        chromaSubsamplingY: true,
        chromaSamplePosition: 0,
        configObus: sequence.raw,
      },
      frameData: frame,
      color: {
        primaries: options.primaries ?? 9,
        transfer: options.transfer,
        matrix: options.matrix ?? 9,
        fullRange: true,
      },
      exifTiff: options.exifTiff ?? null,
    });
  } finally {
    module._free(inputPtr);
    module._free(outPtrPtr);
    module._free(outSizePtr);
  }
}
