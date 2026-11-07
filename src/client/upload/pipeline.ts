import { md5 } from 'hash-wasm';
import { bufferReader, parseHeif, validateAvif } from '../../shared/avif/parse.js';
import { injectExif, setTiffOrientation } from '../../shared/avif/write.js';
import type { UploadMeta } from '../../shared/types.js';
import { detectFormat, formatLabel, isSupportedFormat } from './detect.js';
import { decodeAvif, decodeHeic, decodeWithCanvas, makeThumbnailFromImageData, resizeImageData } from './decode.js';
import { encodeHdr10, encodeSdr } from './encode.js';
import { extractExifTiff, readExifSummary, readOrientation } from './exif.js';
import {
  makeThumbnailFromRgba16,
  resizeRgba16,
  rgba16To10Bit,
  toneMapRgba16,
  toneMapRgba8,
} from './hdr.js';
import type { ProcessOptions, ProcessResult, Stage } from './types.js';

type Progress = (stage: Stage, message: string) => void;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function detectHdrFromBytes(bytes: Uint8Array, format: string): { isHdr: boolean; transfer: number | null } {
  if (format === 'png') {
    let offset = 8;
    while (offset + 8 <= bytes.byteLength) {
      const length = u32be(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      if (type === 'cICP' && length >= 4) {
        const transfer = bytes[offset + 9] ?? 0;
        if (transfer === 16 || transfer === 18) return { isHdr: true, transfer };
      }
      if (type === 'IEND') break;
      offset += 12 + length;
    }
  }
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 2_000_000));
  const text = new TextDecoder('latin1').decode(sample);
  if (/hdrgm|GainMap|urn:iso:std:iso:ts:21496|BT\.2100|SMPTE ST 2084|ARIB STD-B67|HLG/i.test(text)) {
    return { isHdr: true, transfer: null };
  }
  return { isHdr: false, transfer: null };
}

async function decodeAvifPreview(
  bytes: Uint8Array,
  isHdr: boolean,
  transfer: number | null,
  options: ProcessOptions,
): Promise<ImageData> {
  try {
    return await decodeWithCanvas(
      new Blob([toArrayBuffer(bytes)], { type: 'image/avif' }),
      options.previewMaxDimension,
    );
  } catch {
    const imageData = await decodeAvif(bytes);
    const source = isHdr
      ? toneMapRgba8(imageData.data, imageData.width, imageData.height, transfer ?? 16)
      : imageData;
    return resizeImageData(source, options.previewMaxDimension);
  }
}

async function encodePreviewFromImageData(
  imageData: ImageData,
  options: ProcessOptions,
): Promise<Uint8Array> {
  const resized = await resizeImageData(imageData, options.previewMaxDimension);
  return encodeSdr(resized, options.previewQuality, options.speed);
}

export async function processFile(
  id: number,
  file: File,
  options: ProcessOptions,
  onProgress: Progress,
): Promise<ProcessResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes);
  if (!isSupportedFormat(format)) {
    throw new Error(
      format === 'unknown'
        ? '无法识别图片格式，请使用 JPEG、PNG、WebP、HEIC 或 AVIF'
        : `不支持 ${formatLabel(format)} 格式，请先转成 JPEG 或 PNG`,
    );
  }
  onProgress('detect', `检测到 ${formatLabel(format)}`);
  const exifTiff = await extractExifTiff(bytes, format);
  const exifSummary = await readExifSummary(bytes);
  const orientation = await readOrientation(bytes);
  const warnings: string[] = [];

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let isHdr = false;
  let hasAlpha = false;
  let colorPrimaries: number | null = null;
  let transfer: number | null = null;
  let matrix: number | null = null;
  let exifPreserved = false;
  let full: Uint8Array;
  let preview: Uint8Array;
  let thumb: Uint8Array;

  if (format === 'avif') {
    const info = await validateAvif(bufferReader(bytes), {
      kind: 'full',
      maxDimension: 100_000,
      maxPixels: 1_000_000_000,
      maxBytes: 100 * 1024 * 1024,
    });
    width = info.width;
    height = info.height;
    bitDepth = info.bitDepth;
    isHdr = info.isHdr;
    hasAlpha = info.hasAlpha;
    colorPrimaries = info.color?.primaries ?? null;
    transfer = info.color?.transfer ?? null;
    matrix = info.color?.matrix ?? null;
    const tooLarge =
      width > options.maxDimension ||
      height > options.maxDimension ||
      width * height > options.maxPixels;
    if (!tooLarge) {
      full = bytes;
      exifPreserved = info.hasExif;
      onProgress('encode-preview', '生成预览图');
      const previewImage = await decodeAvifPreview(bytes, isHdr, transfer, options);
      preview = await encodeSdr(previewImage, options.previewQuality, options.speed);
      onProgress('encode-thumb', '生成缩略图');
      const thumbImage = await makeThumbnailFromImageData(previewImage);
      thumb = await encodeSdr(thumbImage, options.thumbQuality, options.speed);
    } else {
      if (isHdr) {
        throw new Error('HDR AVIF 尺寸超过限制，无法在浏览器中无损缩小；请先导出较小的 HDR AVIF');
      }
      onProgress('decode', 'AVIF 尺寸超过限制，重新编码');
      let imageData: ImageData;
      try {
        imageData = await decodeWithCanvas(
          new Blob([toArrayBuffer(bytes)], { type: 'image/avif' }),
          options.maxDimension,
        );
      } catch {
        imageData = await decodeAvif(bytes);
      }
      const resized = await resizeImageData(imageData, options.maxDimension);
      onProgress('encode-full', '编码 AVIF');
      full = await encodeSdr(resized, options.fullQuality, options.speed);
      if (exifTiff) {
        try {
          full = await injectExif(full, setTiffOrientation(exifTiff, 1));
          exifPreserved = true;
        } catch {
          warnings.push('EXIF 保留失败，已上传不含 EXIF 的版本');
        }
      }
      onProgress('encode-preview', '生成预览图');
      preview = await encodePreviewFromImageData(resized, options);
      onProgress('encode-thumb', '生成缩略图');
      const thumbImage = await makeThumbnailFromImageData(resized);
      thumb = await encodeSdr(thumbImage, options.thumbQuality, options.speed);
      width = resized.width;
      height = resized.height;
      bitDepth = 8;
      isHdr = false;
    }
  } else if (format === 'heic') {
    const info = await parseHeif(bufferReader(bytes));
    width = info.width;
    height = info.height;
    bitDepth = info.bitDepth;
    isHdr = info.isHdr;
    colorPrimaries = info.color?.primaries ?? null;
    transfer = info.color?.transfer ?? null;
    matrix = info.color?.matrix ?? null;
    if (isHdr && transfer === null) {
      transfer = 16;
      warnings.push('HEIC 未标注色彩传输函数，按 PQ 处理');
    }
    onProgress('decode', '解码 HEIC');
    const decoded = await decodeHeic(bytes, isHdr, orientation);
    if (decoded.bitDepth === 10) {
      const resized = resizeRgba16(
        decoded.data as Uint16Array,
        decoded.width,
        decoded.height,
        options.maxDimension,
      );
      const rgba10 = rgba16To10Bit(resized.data);
      const tiff = exifTiff ? setTiffOrientation(exifTiff, 1) : null;
      const hdr = isHdr;
      if (!hdr) warnings.push('10-bit HEIC 未标注 HDR 元数据，按 10-bit SDR 处理');
      const primariesValue = hdr
        ? (colorPrimaries ?? 9)
        : colorPrimaries && colorPrimaries !== 2
          ? colorPrimaries
          : 1;
      const matrixValue = hdr
        ? (matrix ?? 9)
        : matrix && matrix !== 2 && matrix !== 6
          ? matrix
          : 1;
      const transferValue = hdr
        ? (transfer ?? 16)
        : transfer && transfer !== 2
          ? transfer
          : 1;
      onProgress('encode-full', hdr ? '编码 10-bit HDR AVIF' : '编码 10-bit AVIF');
      full = await encodeHdr10(rgba10, {
        width: resized.width,
        height: resized.height,
        quality: options.fullQuality,
        speed: options.speed,
        transfer: transferValue,
        primaries: primariesValue,
        matrix: matrixValue,
        exifTiff: tiff,
      });
      exifPreserved = Boolean(tiff);
      onProgress('encode-preview', '生成预览图');
      const preview16 = resizeRgba16(
        resized.data,
        resized.width,
        resized.height,
        options.previewMaxDimension,
      );
      preview = await encodeSdr(
        toneMapRgba16(preview16.data, preview16.width, preview16.height, transferValue),
        options.previewQuality,
        options.speed,
      );
      onProgress('encode-thumb', '生成缩略图');
      const thumbImage = makeThumbnailFromRgba16(
        resized.data,
        resized.width,
        resized.height,
        transferValue,
      );
      thumb = await encodeSdr(thumbImage, options.thumbQuality, options.speed);
      width = resized.width;
      height = resized.height;
      bitDepth = 10;
      isHdr = hdr;
    } else {
      if (isHdr) warnings.push('HDR 无法保留，已转为 SDR');
      const imageData = new ImageData(
        new Uint8ClampedArray(decoded.data as Uint8Array),
        decoded.width,
        decoded.height,
      );
      const resized = await resizeImageData(imageData, options.maxDimension);
      onProgress('encode-full', '编码 AVIF');
      full = await encodeSdr(resized, options.fullQuality, options.speed);
      if (exifTiff) {
        try {
          full = await injectExif(full, setTiffOrientation(exifTiff, 1));
          exifPreserved = true;
        } catch {
          warnings.push('EXIF 保留失败，已上传不含 EXIF 的版本');
        }
      }
      onProgress('encode-preview', '生成预览图');
      preview = await encodePreviewFromImageData(resized, options);
      onProgress('encode-thumb', '生成缩略图');
      const thumbImage = await makeThumbnailFromImageData(resized);
      thumb = await encodeSdr(thumbImage, options.thumbQuality, options.speed);
      width = resized.width;
      height = resized.height;
      bitDepth = 8;
      isHdr = false;
    }
  } else {
    const hdr = detectHdrFromBytes(bytes, format);
    if (hdr.isHdr) warnings.push('该格式的 HDR 信息无法在浏览器中保留，已转为 SDR');
    onProgress('decode', '解码图片');
    const imageData = await decodeWithCanvas(file, options.maxDimension);
    const resized = await resizeImageData(imageData, options.maxDimension);
    onProgress('encode-full', '编码 AVIF');
    full = await encodeSdr(resized, options.fullQuality, options.speed);
    if (exifTiff) {
      try {
        full = await injectExif(full, setTiffOrientation(exifTiff, 1));
        exifPreserved = true;
      } catch {
        warnings.push('EXIF 保留失败，已上传不含 EXIF 的版本');
      }
    }
    onProgress('encode-preview', '生成预览图');
    preview = await encodePreviewFromImageData(resized, options);
    onProgress('encode-thumb', '生成缩略图');
    const thumbImage = await makeThumbnailFromImageData(resized);
    thumb = await encodeSdr(thumbImage, options.thumbQuality, options.speed);
    width = resized.width;
    height = resized.height;
    bitDepth = 8;
    isHdr = false;
  }

  onProgress('metadata', '计算校验值');
  const fullMd5 = await md5(full);
  const thumbMd5 = await md5(thumb);
  const meta: UploadMeta = {
    originalName: file.name,
    width,
    height,
    md5: fullMd5,
    thumbMd5,
    bitDepth,
    isHdr,
    hasAlpha,
    colorPrimaries: colorPrimaries ?? undefined,
    transferCharacteristics: transfer ?? undefined,
    matrixCoefficients: matrix ?? undefined,
    exifPreserved,
    exifSummary: exifSummary as Record<string, unknown> | null,
  };
  onProgress('done', '完成');
  return {
    type: 'result',
    id,
    full: toArrayBuffer(full),
    preview: toArrayBuffer(preview),
    thumb: toArrayBuffer(thumb),
    meta,
    warnings,
    width,
    height,
    bitDepth,
    isHdr,
    hasAlpha,
    exifPreserved,
  };
}
