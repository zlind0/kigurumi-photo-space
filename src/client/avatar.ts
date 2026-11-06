import { decodeAvif, decodeHeic, decodeWithCanvas, makeThumbnailFromImageData } from './upload/decode.js';
import { detectFormat } from './upload/detect.js';
import { encodeSdr } from './upload/encode.js';

const AVATAR_SIZE = 200;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Decode an arbitrary browser-supported image, center-crop it to a square and
 * encode a 200×200 AVIF. This mirrors the photo thumbnail pipeline so the
 * server only ever receives a validated AVIF avatar.
 */
export async function encodeAvatar(file: File): Promise<Blob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes);
  let imageData: ImageData;
  if (format === 'heic') {
    const decoded = await decodeHeic(bytes, false);
    imageData = new ImageData(
      new Uint8ClampedArray(decoded.data as Uint8Array),
      decoded.width,
      decoded.height,
    );
  } else if (format === 'avif') {
    try {
      imageData = await decodeWithCanvas(file, 4000);
    } catch {
      imageData = await decodeAvif(bytes);
    }
  } else {
    imageData = await decodeWithCanvas(file, 4000);
  }
  const square = await makeThumbnailFromImageData(imageData, AVATAR_SIZE);
  const encoded = await encodeSdr(square, 60, 8);
  return new Blob([toArrayBuffer(encoded)], { type: 'image/avif' });
}
