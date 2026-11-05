export interface Obu {
  type: number;
  offset: number;
  size: number;
  headerSize: number;
  payload: Uint8Array;
  raw: Uint8Array;
}

export const OBU_SEQUENCE_HEADER = 1;
export const OBU_TEMPORAL_DELIMITER = 2;
export const OBU_FRAME_HEADER = 3;
export const OBU_TILE_GROUP = 4;
export const OBU_FRAME = 6;

function readLeb128(data: Uint8Array, offset: number): { value: number; bytes: number } {
  let value = 0;
  let shift = 0;
  let bytes = 0;
  while (offset + bytes < data.byteLength) {
    const byte = data[offset + bytes]!;
    value |= (byte & 0x7f) << shift;
    bytes++;
    if ((byte & 0x80) === 0) return { value, bytes };
    shift += 7;
    if (shift > 28) break;
  }
  throw new Error('无效的 OBU 长度');
}

export function parseObus(data: Uint8Array): Obu[] {
  const obus: Obu[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    const start = offset;
    const header = data[offset]!;
    const type = (header >> 3) & 0x0f;
    const extension = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    offset++;
    if (extension) offset++;
    let size: number;
    let headerSize = offset - start;
    if (hasSize) {
      const leb = readLeb128(data, offset);
      size = leb.value;
      offset += leb.bytes;
      headerSize = offset - start;
    } else {
      size = data.byteLength - offset;
    }
    if (offset + size > data.byteLength) {
      throw new Error('OBU 超出数据范围');
    }
    obus.push({
      type,
      offset: start,
      size: headerSize + size,
      headerSize,
      payload: data.subarray(offset, offset + size),
      raw: data.subarray(start, offset + size),
    });
    offset += size;
  }
  return obus;
}

class BitReader {
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}
  f(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.bit >> 3];
      if (byte === undefined) throw new Error('序列头被截断');
      const b = (byte >> (7 - (this.bit & 7))) & 1;
      value = (value << 1) | b;
      this.bit++;
    }
    return value;
  }
  uvlc(): number {
    let leadingZeros = 0;
    while (this.f(1) === 0) {
      leadingZeros++;
      if (leadingZeros > 32) throw new Error('uvlc 非法');
    }
    if (leadingZeros === 0) return 0;
    return (1 << leadingZeros) - 1 + this.f(leadingZeros);
  }
}

export interface SequenceHeaderInfo {
  seqProfile: number;
  seqLevelIdx0: number;
  seqTier0: number;
  stillPicture: boolean;
  reducedStillPictureHeader: boolean;
}

export function parseSequenceHeader(payload: Uint8Array): SequenceHeaderInfo {
  const r = new BitReader(payload);
  const seqProfile = r.f(3);
  const stillPicture = r.f(1) === 1;
  const reduced = r.f(1) === 1;
  let seqLevelIdx0 = 0;
  let seqTier0 = 0;
  if (reduced) {
    seqLevelIdx0 = r.f(5);
  } else {
    const timingInfoPresent = r.f(1) === 1;
    if (timingInfoPresent) {
      r.f(32);
      r.f(32);
      const equalPictureInterval = r.f(1) === 1;
      if (equalPictureInterval) r.uvlc();
    }
    const decoderModelInfoPresent = r.f(1) === 1;
    if (decoderModelInfoPresent) {
      r.f(5);
      r.f(32);
      r.f(5);
      r.f(5);
    }
    const initialDisplayDelayPresent = r.f(1) === 1;
    const operatingPoints = r.f(5) + 1;
    for (let i = 0; i < operatingPoints; i++) {
      r.f(12);
      const level = r.f(5);
      let tier = 0;
      if (level > 7) tier = r.f(1);
      if (initialDisplayDelayPresent) {
        const present = r.f(1) === 1;
        if (present) r.f(4);
      }
      if (i === 0) {
        seqLevelIdx0 = level;
        seqTier0 = tier;
      }
    }
  }
  return { seqProfile, seqLevelIdx0, seqTier0, stillPicture, reducedStillPictureHeader: reduced };
}

export function findSequenceHeader(obus: Obu[]): Obu | null {
  return obus.find((o) => o.type === OBU_SEQUENCE_HEADER) ?? null;
}

export function frameObus(obus: Obu[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const obu of obus) {
    if (obu.type === OBU_SEQUENCE_HEADER) continue;
    parts.push(obu.raw);
    total += obu.raw.byteLength;
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.byteLength;
  }
  return out;
}
