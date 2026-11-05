import type { InputFormat } from './types.js';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

export function detectFormat(bytes: Uint8Array): InputFormat {
  if (bytes.byteLength < 12) return 'unknown';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (ascii(bytes, 0, 4) === 'II*\0' || ascii(bytes, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) {
      return 'heic';
    }
    // Some HEIC files use mif1 as major brand but list heic in compatible brands.
    for (let offset = 16; offset + 4 <= Math.min(bytes.byteLength, 64); offset += 4) {
      const compatible = ascii(bytes, offset, 4);
      if (compatible === 'avif') return 'avif';
      if (['heic', 'heix', 'hevc', 'hevx'].includes(compatible)) return 'heic';
    }
  }
  return 'unknown';
}

export function isSupportedFormat(format: InputFormat): boolean {
  return format === 'avif' || format === 'heic' || format === 'jpeg' || format === 'png' || format === 'webp';
}

export function formatLabel(format: InputFormat): string {
  switch (format) {
    case 'avif':
      return 'AVIF';
    case 'heic':
      return 'HEIC/HEIF';
    case 'jpeg':
      return 'JPEG';
    case 'png':
      return 'PNG';
    case 'webp':
      return 'WebP';
    case 'gif':
      return 'GIF';
    case 'tiff':
      return 'TIFF';
    case 'bmp':
      return 'BMP';
    default:
      return '未知格式';
  }
}
