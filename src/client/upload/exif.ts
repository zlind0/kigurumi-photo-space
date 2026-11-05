import exifr from 'exifr';
import { bufferReader, parseIsobmff, readItemData } from '../../shared/avif/parse.js';
import type { InputFormat } from './types.js';

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

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    ((bytes[offset + 3]! << 24) >>> 0)
  );
}

function jpegExif(bytes: Uint8Array): Uint8Array | null {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) break;
    if (marker === 0xe1 && ascii(bytes, offset + 4, 6) === 'Exif\0\0') {
      return bytes.slice(offset + 10, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return null;
}

function pngExif(bytes: Uint8Array): Uint8Array | null {
  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (type === 'eXIf') {
      return bytes.slice(offset + 8, offset + 8 + length);
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}

function webpExif(bytes: Uint8Array): Uint8Array | null {
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    if (type === 'EXIF') {
      let data = bytes.slice(offset + 8, offset + 8 + length);
      if (ascii(data, 0, 6) === 'Exif\0\0') data = data.slice(6);
      return data;
    }
    offset += 8 + length + (length & 1);
  }
  return null;
}

async function heifExif(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const reader = bufferReader(bytes);
    const file = await parseIsobmff(reader);
    const item = file.meta?.items.find((entry) => entry.type === 'Exif');
    if (!item) return null;
    const location = file.meta?.locations.find((entry) => entry.id === item.id);
    if (!location) return null;
    const data = await readItemData(reader, file, location);
    if (data.byteLength < 4) return null;
    const offset = u32be(data, 0);
    if (4 + offset >= data.byteLength) return null;
    return data.slice(4 + offset);
  } catch {
    return null;
  }
}

export async function extractExifTiff(bytes: Uint8Array, format: InputFormat): Promise<Uint8Array | null> {
  switch (format) {
    case 'jpeg':
      return jpegExif(bytes);
    case 'png':
      return pngExif(bytes);
    case 'webp':
      return webpExif(bytes);
    case 'avif':
    case 'heic':
      return heifExif(bytes);
    default:
      return null;
  }
}

export interface ExifSummary {
  Make?: string;
  Model?: string;
  LensModel?: string;
  DateTimeOriginal?: string | Date;
  GPSLatitude?: number;
  GPSLongitude?: number;
  Orientation?: number;
  ExposureTime?: number;
  FNumber?: number;
  ISO?: number;
  FocalLength?: number;
}

export async function readExifSummary(bytes: Uint8Array): Promise<ExifSummary | null> {
  try {
    const parsed = (await exifr.parse(bytes, {
      pick: [
        'Make',
        'Model',
        'LensModel',
        'DateTimeOriginal',
        'GPSLatitude',
        'GPSLongitude',
        'Orientation',
        'ExposureTime',
        'FNumber',
        'ISO',
        'FocalLength',
      ],
    })) as ExifSummary | undefined;
    if (!parsed) return null;
    const summary: ExifSummary = {};
    for (const key of Object.keys(parsed) as Array<keyof ExifSummary>) {
      const value = parsed[key];
      if (value === undefined || value === null) continue;
      if (value instanceof Date) summary[key] = value.toISOString() as never;
      else summary[key] = value as never;
    }
    return Object.keys(summary).length ? summary : null;
  } catch {
    return null;
  }
}

export async function readOrientation(bytes: Uint8Array): Promise<number> {
  try {
    const parsed = (await exifr.parse(bytes, { pick: ['Orientation'] })) as { Orientation?: number } | undefined;
    const value = parsed?.Orientation;
    return typeof value === 'number' && value >= 1 && value <= 8 ? value : 1;
  } catch {
    return 1;
  }
}
