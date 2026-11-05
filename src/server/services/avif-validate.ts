import { open, stat } from 'node:fs/promises';
import type { Config } from '../config.js';
import { validateAvif, type Reader } from '../../shared/avif/parse.js';
import type { AvifInfo } from '../../shared/avif/types.js';
import { AvifValidationError } from '../../shared/avif/types.js';
import { AppError } from '../http/errors.js';

export async function fileReader(path: string): Promise<Reader> {
  const info = await stat(path);
  const handle = await open(path, 'r');
  return {
    size: info.size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > info.size) {
        throw new AvifValidationError('TRUNCATED', '文件被截断');
      }
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, offset + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
    },
  };
}

export async function validateAvifFile(
  path: string,
  kind: 'full' | 'thumb',
  config: Config,
): Promise<AvifInfo> {
  const reader = await fileReader(path);
  try {
    return await validateAvif(reader, {
      kind,
      maxDimension: config.maxImageDimension,
      maxPixels: config.maxImagePixels,
      maxBytes: kind === 'full' ? config.maxFullBytes : config.maxThumbBytes,
    });
  } catch (error) {
    if (error instanceof AvifValidationError) {
      const status = error.code === 'FILE_TOO_LARGE' ? 413 : error.code === 'UNSUPPORTED_FORMAT' ? 415 : 422;
      const code =
        error.code === 'FILE_TOO_LARGE'
          ? 'FILE_TOO_LARGE'
          : error.code === 'UNSUPPORTED_FORMAT'
            ? 'UNSUPPORTED_FORMAT'
            : kind === 'thumb'
              ? 'INVALID_THUMBNAIL'
              : 'INVALID_AVIF';
      throw new AppError(status, code, error.message);
    }
    throw error;
  }
}
