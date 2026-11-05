import { init as initAvifDecode, decode as decodeAvifWasm } from '@phenomen/libavif-wasm/decode';
import { applyOrientation, applyOrientation16 } from './hdr.js';

let avifDecodeReady: Promise<void> | null = null;

async function ensureAvifDecode(): Promise<void> {
  if (!avifDecodeReady) avifDecodeReady = initAvifDecode();
  await avifDecodeReady;
}

export async function decodeAvif(bytes: Uint8Array): Promise<ImageData> {
  await ensureAvifDecode();
  const result = await decodeAvifWasm(bytes);
  return new ImageData(new Uint8ClampedArray(result.data), result.width, result.height);
}

export async function decodeWithCanvas(
  blob: Blob,
  maxDimension: number,
  orientation = 1,
): Promise<ImageData> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  void orientation;
  return ctx.getImageData(0, 0, width, height);
}

export async function resizeImageData(imageData: ImageData, maxDimension: number): Promise<ImageData> {
  const longest = Math.max(imageData.width, imageData.height);
  if (longest <= maxDimension) return imageData;
  const scale = maxDimension / longest;
  const width = Math.max(1, Math.round(imageData.width * scale));
  const height = Math.max(1, Math.round(imageData.height * scale));
  const bitmap = await createImageBitmap(imageData, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

export async function makeThumbnailFromImageData(imageData: ImageData, size = 600): Promise<ImageData> {
  const side = Math.min(imageData.width, imageData.height);
  const sx = (imageData.width - side) / 2;
  const sy = (imageData.height - side) / 2;
  const bitmap = await createImageBitmap(imageData);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close();
  return ctx.getImageData(0, 0, size, size);
}

export interface HeicDecodeResult {
  data: Uint8Array | Uint16Array;
  width: number;
  height: number;
  bitDepth: 8 | 10;
}

interface HeifImageLike {
  handle: unknown;
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, callback: (result: unknown) => void): void;
}

interface HeifModule {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImageLike[] };
  heif_js_decode_image2(handle: unknown, colorspace: unknown, chroma: unknown): {
    code?: number;
    channels?: Array<{ data: Uint8Array; width: number; height: number; stride: number }>;
  };
  heif_colorspace: { heif_colorspace_RGB: unknown };
  heif_chroma: {
    heif_chroma_interleaved_RGBA: unknown;
    heif_chroma_interleaved_RRGGBBAA_LE: unknown;
  };
}

let heifModulePromise: Promise<HeifModule> | null = null;

async function loadHeif(): Promise<HeifModule> {
  if (!heifModulePromise) {
    heifModulePromise = import('libheif-js/wasm-bundle').then((module) => {
      const candidate = (module as { default?: HeifModule }).default ?? (module as unknown as HeifModule);
      return candidate;
    });
  }
  return heifModulePromise;
}

export async function decodeHeic(
  bytes: Uint8Array,
  want16Bit: boolean,
  orientation = 1,
): Promise<HeicDecodeResult> {
  const libheif = await loadHeif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images.length) throw new Error('无法解码 HEIC 图片');
  const image = images[0]!;
  const width = image.get_width();
  const height = image.get_height();
  if (width <= 0 || height <= 0) throw new Error('HEIC 图片尺寸无效');

  if (want16Bit) {
    try {
      const result = libheif.heif_js_decode_image2(
        image.handle,
        libheif.heif_colorspace.heif_colorspace_RGB,
        libheif.heif_chroma.heif_chroma_interleaved_RRGGBBAA_LE,
      );
      const channel = result.channels?.[0];
      if (channel && channel.data.byteLength >= width * height * 8) {
        const data = new Uint16Array(width * height * 4);
        if (channel.stride === width * 8 && channel.data.byteOffset % 2 === 0) {
          const view = new Uint16Array(channel.data.buffer, channel.data.byteOffset, width * height * 4);
          data.set(view);
        } else {
          const view = new DataView(channel.data.buffer, channel.data.byteOffset, channel.data.byteLength);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const src = y * channel.stride + x * 8;
              const dst = (y * width + x) * 4;
              data[dst] = view.getUint16(src, true);
              data[dst + 1] = view.getUint16(src + 2, true);
              data[dst + 2] = view.getUint16(src + 4, true);
              data[dst + 3] = view.getUint16(src + 6, true);
            }
          }
        }
        const oriented = applyOrientation16(data, width, height, orientation);
        return { data: oriented.data, width: oriented.width, height: oriented.height, bitDepth: 10 };
      }
    } catch {
      // fall through to 8-bit
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data, width, height }, (result) => {
      if (result) resolve();
      else reject(new Error('HEIC 解码失败'));
    });
  });
  let imageData = new ImageData(data, width, height);
  if (orientation > 1) imageData = await applyOrientation(imageData, orientation);
  return {
    data: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
    width: imageData.width,
    height: imageData.height,
    bitDepth: 8,
  };
}
