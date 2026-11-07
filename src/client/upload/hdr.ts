const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

export function isHdrTransfer(transfer: number | null | undefined): boolean {
  return transfer === 16 || transfer === 18;
}

export function pqEotf(value: number): number {
  const e = Math.max(0, Math.min(1, value));
  const p = Math.pow(e, 1 / PQ_M2);
  const numerator = Math.max(p - PQ_C1, 0);
  const denominator = PQ_C2 - PQ_C3 * p;
  if (denominator <= 0) return 10000;
  return Math.pow(numerator / denominator, 1 / PQ_M1) * 10000;
}

export function hlgEotf(value: number): number {
  const e = Math.max(0, Math.min(1, value));
  if (e <= 0.5) return (e * e) / 3;
  return (Math.exp((e - HLG_C) / HLG_A) + HLG_B) / 12;
}

function srgbEncode(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function toneMapNits(nits: number): number {
  const relative = Math.max(0, nits) / 100;
  const mapped = relative / (1 + relative * 0.6);
  return Math.round(srgbEncode(mapped) * 255);
}

function toneMapChannel(value: number, transfer: number): number {
  if (transfer === 16) return toneMapNits(pqEotf(value));
  if (transfer === 18) return toneMapNits(hlgEotf(value) * 1000);
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

export function toneMapRgba16(
  data: Uint16Array,
  width: number,
  height: number,
  transfer: number,
): ImageData {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const index = i * 4;
    out[index] = toneMapChannel((data[index] ?? 0) / 65535, transfer);
    out[index + 1] = toneMapChannel((data[index + 1] ?? 0) / 65535, transfer);
    out[index + 2] = toneMapChannel((data[index + 2] ?? 0) / 65535, transfer);
    out[index + 3] = Math.round(((data[index + 3] ?? 0) / 65535) * 255);
  }
  return new ImageData(out, width, height);
}

export function toneMapRgba8(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  transfer: number,
): ImageData {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const index = i * 4;
    out[index] = toneMapChannel((data[index] ?? 0) / 255, transfer);
    out[index + 1] = toneMapChannel((data[index + 1] ?? 0) / 255, transfer);
    out[index + 2] = toneMapChannel((data[index + 2] ?? 0) / 255, transfer);
    out[index + 3] = data[index + 3] ?? 255;
  }
  return new ImageData(out, width, height);
}

function sampleBilinear16(
  data: Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const p00 = data[(y0 * width + x0) * 4 + channel] ?? 0;
  const p10 = data[(y0 * width + x1) * 4 + channel] ?? 0;
  const p01 = data[(y1 * width + x0) * 4 + channel] ?? 0;
  const p11 = data[(y1 * width + x1) * 4 + channel] ?? 0;
  const top = p00 + (p10 - p00) * fx;
  const bottom = p01 + (p11 - p01) * fx;
  return top + (bottom - top) * fy;
}

function sampleBilinear8(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const p00 = data[(y0 * width + x0) * 4 + channel] ?? 0;
  const p10 = data[(y0 * width + x1) * 4 + channel] ?? 0;
  const p01 = data[(y1 * width + x0) * 4 + channel] ?? 0;
  const p11 = data[(y1 * width + x1) * 4 + channel] ?? 0;
  const top = p00 + (p10 - p00) * fx;
  const bottom = p01 + (p11 - p01) * fx;
  return top + (bottom - top) * fy;
}

export function makeThumbnailFromRgba16(
  data: Uint16Array,
  width: number,
  height: number,
  transfer: number,
  size = 600,
): ImageData {
  const side = Math.min(width, height);
  const offsetX = (width - side) / 2;
  const offsetY = (height - side) / 2;
  const out = new Uint8ClampedArray(size * size * 4);
  const scale = side / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = offsetX + (x + 0.5) * scale - 0.5;
      const sy = offsetY + (y + 0.5) * scale - 0.5;
      const r = sampleBilinear16(data, width, height, sx, sy, 0) / 65535;
      const g = sampleBilinear16(data, width, height, sx, sy, 1) / 65535;
      const b = sampleBilinear16(data, width, height, sx, sy, 2) / 65535;
      const a = sampleBilinear16(data, width, height, sx, sy, 3) / 65535;
      const index = (y * size + x) * 4;
      out[index] = toneMapChannel(r, transfer);
      out[index + 1] = toneMapChannel(g, transfer);
      out[index + 2] = toneMapChannel(b, transfer);
      out[index + 3] = Math.round(a * 255);
    }
  }
  return new ImageData(out, size, size);
}

export function makeThumbnailFromRgba8(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  transfer: number,
  size = 600,
): ImageData {
  const side = Math.min(width, height);
  const offsetX = (width - side) / 2;
  const offsetY = (height - side) / 2;
  const out = new Uint8ClampedArray(size * size * 4);
  const scale = side / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = offsetX + (x + 0.5) * scale - 0.5;
      const sy = offsetY + (y + 0.5) * scale - 0.5;
      const r = sampleBilinear8(data, width, height, sx, sy, 0) / 255;
      const g = sampleBilinear8(data, width, height, sx, sy, 1) / 255;
      const b = sampleBilinear8(data, width, height, sx, sy, 2) / 255;
      const a = sampleBilinear8(data, width, height, sx, sy, 3) / 255;
      const index = (y * size + x) * 4;
      out[index] = toneMapChannel(r, transfer);
      out[index + 1] = toneMapChannel(g, transfer);
      out[index + 2] = toneMapChannel(b, transfer);
      out[index + 3] = Math.round(a * 255);
    }
  }
  return new ImageData(out, size, size);
}

export function resizeRgba16(
  data: Uint16Array,
  width: number,
  height: number,
  maxDimension: number,
): { data: Uint16Array; width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { data, width, height };
  const scale = maxDimension / longest;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint16Array(outWidth * outHeight * 4);
  const sxScale = width / outWidth;
  const syScale = height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const sx = (x + 0.5) * sxScale - 0.5;
      const sy = (y + 0.5) * syScale - 0.5;
      const index = (y * outWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[index + c] = Math.round(sampleBilinear16(data, width, height, sx, sy, c));
      }
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

export function rgba16To10Bit(data: Uint16Array): Uint16Array {
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.max(0, Math.min(1023, Math.round((data[i]! * 1023) / 65535)));
  }
  return out;
}

export async function applyOrientation(imageData: ImageData, orientation: number): Promise<ImageData> {
  if (orientation <= 1 || orientation > 8) return imageData;
  const { width, height } = imageData;
  const swap = orientation >= 5;
  const canvas = new OffscreenCanvas(swap ? height : width, swap ? width : height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageData;
  const source = new OffscreenCanvas(width, height);
  const sourceCtx = source.getContext('2d');
  if (!sourceCtx) return imageData;
  sourceCtx.putImageData(imageData, 0, 0);
  switch (orientation) {
    case 2:
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      break;
    case 3:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case 4:
      ctx.translate(0, height);
      ctx.scale(1, -1);
      break;
    case 5:
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6:
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(0, -height);
      break;
    case 7:
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(width, -height);
      ctx.scale(-1, 1);
      break;
    case 8:
      ctx.rotate(-0.5 * Math.PI);
      ctx.translate(-width, 0);
      break;
    default:
      break;
  }
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function applyOrientation16(
  data: Uint16Array,
  width: number,
  height: number,
  orientation: number,
): { data: Uint16Array; width: number; height: number } {
  if (orientation <= 1 || orientation > 8) return { data, width, height };
  const swap = orientation >= 5;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const out = new Uint16Array(outWidth * outHeight * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2:
          dx = width - 1 - x;
          dy = y;
          break;
        case 3:
          dx = width - 1 - x;
          dy = height - 1 - y;
          break;
        case 4:
          dx = x;
          dy = height - 1 - y;
          break;
        case 5:
          dx = y;
          dy = x;
          break;
        case 6:
          dx = height - 1 - y;
          dy = x;
          break;
        case 7:
          dx = height - 1 - y;
          dy = width - 1 - x;
          break;
        case 8:
          dx = y;
          dy = width - 1 - x;
          break;
        default:
          dx = x;
          dy = y;
      }
      const src = (y * width + x) * 4;
      const dst = (dy * outWidth + dx) * 4;
      out[dst] = data[src]!;
      out[dst + 1] = data[src + 1]!;
      out[dst + 2] = data[src + 2]!;
      out[dst + 3] = data[src + 3]!;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}
