import {
  AvifValidationError,
  type Av1Config,
  type AvifInfo,
  type BoxHeader,
  type ContentLightLevel,
  type Extent,
  type FtypInfo,
  type HeifInfo,
  type IsobmffFile,
  type ItemInfo,
  type ItemLocation,
  type ItemReference,
  type MasteringDisplay,
  type NclxColor,
  type PropertyAssociation,
  type PropertyBox,
} from './types.js';

export interface Reader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bufferReader(buffer: Uint8Array): Reader {
  return {
    size: buffer.byteLength,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > buffer.byteLength) {
        throw new AvifValidationError('TRUNCATED', '文件被截断');
      }
      return buffer.subarray(offset, offset + length);
    },
  };
}

const textDecoder = new TextDecoder('latin1');

function fourcc(bytes: Uint8Array, offset: number): string {
  return textDecoder.decode(bytes.subarray(offset, offset + 4));
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function u64(bytes: Uint8Array, offset: number): number {
  const hi = u32(bytes, offset);
  const lo = u32(bytes, offset + 4);
  return hi * 0x100000000 + lo;
}

function readUint(bytes: Uint8Array, offset: number, size: number): number {
  if (size === 0) return 0;
  if (size === 1) return bytes[offset]!;
  if (size === 2) return u16(bytes, offset);
  if (size === 4) return u32(bytes, offset);
  if (size === 8) return u64(bytes, offset);
  throw new AvifValidationError('INVALID_BOX', `不支持的长度字段: ${size}`);
}

function cString(bytes: Uint8Array, offset: number, end: number): string {
  let i = offset;
  while (i < end && bytes[i] !== 0) i++;
  return new TextDecoder().decode(bytes.subarray(offset, i));
}

async function readBoxHeader(
  reader: Reader,
  offset: number,
  limit: number,
): Promise<BoxHeader | null> {
  if (offset + 8 > limit) return null;
  const head = await reader.read(offset, Math.min(32, limit - offset));
  let size = u32(head, 0);
  const type = fourcc(head, 4);
  let headerSize = 8;
  if (size === 1) {
    if (head.byteLength < 16) throw new AvifValidationError('TRUNCATED', 'box 头被截断');
    size = u64(head, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (type === 'uuid') headerSize += 16;
  if (size < headerSize) {
    throw new AvifValidationError('INVALID_BOX', `box ${type} 大小非法`);
  }
  if (offset + size > limit) {
    throw new AvifValidationError('INVALID_BOX', `box ${type} 超出文件范围`);
  }
  return { type, offset, size, headerSize };
}

function parseFtyp(payload: Uint8Array): FtypInfo {
  if (payload.byteLength < 8) throw new AvifValidationError('INVALID_FTYP', 'ftyp 太短');
  const majorBrand = fourcc(payload, 0);
  const minorVersion = u32(payload, 4);
  const compatibleBrands: string[] = [];
  for (let i = 8; i + 4 <= payload.byteLength; i += 4) {
    compatibleBrands.push(fourcc(payload, i));
  }
  return { majorBrand, minorVersion, compatibleBrands };
}

function parsePitm(payload: Uint8Array): number {
  if (payload.byteLength < 6) throw new AvifValidationError('INVALID_PITM', 'pitm 太短');
  const version = payload[0]!;
  return version === 0 ? u16(payload, 4) : u32(payload, 4);
}

function parseIinf(payload: Uint8Array): ItemInfo[] {
  if (payload.byteLength < 6) throw new AvifValidationError('INVALID_IINF', 'iinf 太短');
  const version = payload[0]!;
  let offset = 4;
  const count = version === 0 ? u16(payload, offset) : u32(payload, offset);
  offset += version === 0 ? 2 : 4;
  const items: ItemInfo[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 8 > payload.byteLength) {
      throw new AvifValidationError('INVALID_IINF', 'iinf 条目被截断');
    }
    const size = u32(payload, offset);
    const type = fourcc(payload, offset + 4);
    if (type !== 'infe') {
      throw new AvifValidationError('INVALID_IINF', `iinf 中出现非 infe box: ${type}`);
    }
    if (size < 8 || offset + size > payload.byteLength) {
      throw new AvifValidationError('INVALID_IINF', 'infe 大小非法');
    }
    const infe = payload.subarray(offset + 8, offset + size);
    const infeVersion = infe[0]!;
    let p = 4;
    let id: number;
    let protectionIndex: number;
    let itemType = '';
    let name = '';
    if (infeVersion >= 2) {
      id = infeVersion === 2 ? u16(infe, p) : u32(infe, p);
      p += infeVersion === 2 ? 2 : 4;
      protectionIndex = u16(infe, p);
      p += 2;
      itemType = fourcc(infe, p);
      p += 4;
      name = cString(infe, p, infe.byteLength);
    } else {
      id = u16(infe, p);
      p += 2;
      protectionIndex = u16(infe, p);
      p += 2;
      name = cString(infe, p, infe.byteLength);
    }
    items.push({ id, type: itemType, name, protectionIndex });
    offset += size;
  }
  return items;
}

function parseIloc(payload: Uint8Array): ItemLocation[] {
  if (payload.byteLength < 8) throw new AvifValidationError('INVALID_ILOC', 'iloc 太短');
  const version = payload[0]!;
  const flags = (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
  let p = 4;
  const offsetSize = payload[p]! >> 4;
  const lengthSize = payload[p]! & 0x0f;
  p += 1;
  const baseOffsetSize = payload[p]! >> 4;
  const indexSize = version >= 1 ? payload[p]! & 0x0f : 0;
  p += 1;
  if (offsetSize !== 4 && offsetSize !== 8 && offsetSize !== 0) {
    throw new AvifValidationError('INVALID_ILOC', 'iloc offset_size 非法');
  }
  if (lengthSize !== 4 && lengthSize !== 8 && lengthSize !== 0) {
    throw new AvifValidationError('INVALID_ILOC', 'iloc length_size 非法');
  }
  const count = version < 2 ? u16(payload, p) : u32(payload, p);
  p += version < 2 ? 2 : 4;
  const locations: ItemLocation[] = [];
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? u16(payload, p) : u32(payload, p);
    p += version < 2 ? 2 : 4;
    let constructionMethod = 0;
    if (version >= 1) {
      constructionMethod = payload[p]! & 0x0f;
      p += 2;
    }
    const dataReferenceIndex = u16(payload, p);
    p += 2;
    const baseOffset = readUint(payload, p, baseOffsetSize);
    p += baseOffsetSize;
    const extentCount = u16(payload, p);
    p += 2;
    const extents: Extent[] = [];
    for (let e = 0; e < extentCount; e++) {
      if (version >= 1 && indexSize > 0) {
        p += indexSize;
      }
      const extentOffset = readUint(payload, p, offsetSize);
      p += offsetSize;
      const extentLength = readUint(payload, p, lengthSize);
      p += lengthSize;
      extents.push({ offset: extentOffset, length: extentLength });
    }
    locations.push({ id, constructionMethod, dataReferenceIndex, baseOffset, extents });
  }
  void flags;
  return locations;
}

function parseIpco(payload: Uint8Array): PropertyBox[] {
  const properties: PropertyBox[] = [];
  let offset = 0;
  let index = 1;
  while (offset + 8 <= payload.byteLength) {
    const size = u32(payload, offset);
    const type = fourcc(payload, offset + 4);
    if (size < 8 || offset + size > payload.byteLength) {
      throw new AvifValidationError('INVALID_IPCO', 'ipco 属性大小非法');
    }
    properties.push({
      index,
      type,
      raw: payload.subarray(offset, offset + size),
    });
    offset += size;
    index++;
  }
  return properties;
}

function parseIpma(payload: Uint8Array): PropertyAssociation[] {
  if (payload.byteLength < 8) throw new AvifValidationError('INVALID_IPMA', 'ipma 太短');
  const version = payload[0]!;
  const flags = (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
  const wide = (flags & 1) !== 0;
  let p = 4;
  const count = u32(payload, p);
  p += 4;
  const associations: PropertyAssociation[] = [];
  for (let i = 0; i < count; i++) {
    const itemId = version < 1 ? u16(payload, p) : u32(payload, p);
    p += version < 1 ? 2 : 4;
    const associationCount = payload[p]!;
    p += 1;
    for (let a = 0; a < associationCount; a++) {
      if (wide) {
        const value = u16(payload, p);
        p += 2;
        associations.push({
          itemId,
          essential: (value & 0x8000) !== 0,
          propertyIndex: value & 0x7fff,
        });
      } else {
        const value = payload[p]!;
        p += 1;
        associations.push({
          itemId,
          essential: (value & 0x80) !== 0,
          propertyIndex: value & 0x7f,
        });
      }
    }
  }
  return associations;
}

function parseIref(payload: Uint8Array): ItemReference[] {
  if (payload.byteLength < 8) throw new AvifValidationError('INVALID_IREF', 'iref 太短');
  const version = payload[0]!;
  let p = 4;
  const refs: ItemReference[] = [];
  while (p + 8 <= payload.byteLength) {
    const size = u32(payload, p);
    const type = fourcc(payload, p + 4);
    if (size < 8 || p + size > payload.byteLength) {
      throw new AvifValidationError('INVALID_IREF', 'iref 引用大小非法');
    }
    let q = p + 8;
    const fromItemId = version < 1 ? u16(payload, q) : u32(payload, q);
    q += version < 1 ? 2 : 4;
    const count = u16(payload, q);
    q += 2;
    const toItemIds: number[] = [];
    for (let i = 0; i < count; i++) {
      toItemIds.push(version < 1 ? u16(payload, q) : u32(payload, q));
      q += version < 1 ? 2 : 4;
    }
    refs.push({ type, fromItemId, toItemIds });
    p += size;
  }
  return refs;
}

function parseMeta(payload: Uint8Array): NonNullable<IsobmffFile['meta']> {
  const meta: NonNullable<IsobmffFile['meta']> = {
    offset: 0,
    size: 0,
    handlerType: null,
    primaryItemId: null,
    items: [],
    locations: [],
    properties: [],
    associations: [],
    references: [],
    idat: null,
    versionFlags: 0,
    rawChildren: [],
  };
  meta.versionFlags = u32(payload, 0);
  let offset = 4; // full box version/flags
  while (offset + 8 <= payload.byteLength) {
    const size = u32(payload, offset);
    const type = fourcc(payload, offset + 4);
    if (size < 8 || offset + size > payload.byteLength) {
      throw new AvifValidationError('INVALID_META', `meta 子 box ${type} 大小非法`);
    }
    const body = payload.subarray(offset + 8, offset + size);
    meta.rawChildren.push({ type, raw: payload.subarray(offset, offset + size) });
    switch (type) {
      case 'hdlr':
        if (body.byteLength >= 12) meta.handlerType = fourcc(body, 8);
        break;
      case 'pitm':
        meta.primaryItemId = parsePitm(body);
        break;
      case 'iinf':
        meta.items = parseIinf(body);
        break;
      case 'iloc':
        meta.locations = parseIloc(body);
        break;
      case 'iref':
        meta.references = parseIref(body);
        break;
      case 'idat':
        meta.idat = body;
        break;
      case 'iprp': {
        let p = 0;
        while (p + 8 <= body.byteLength) {
          const childSize = u32(body, p);
          const childType = fourcc(body, p + 4);
          if (childSize < 8 || p + childSize > body.byteLength) {
            throw new AvifValidationError('INVALID_IPRP', 'iprp 子 box 大小非法');
          }
          const child = body.subarray(p + 8, p + childSize);
          if (childType === 'ipco') meta.properties = parseIpco(child);
          else if (childType === 'ipma') meta.associations = parseIpma(child);
          p += childSize;
        }
        break;
      }
      default:
        break;
    }
    offset += size;
  }
  return meta;
}

export async function parseIsobmff(reader: Reader): Promise<IsobmffFile> {
  const boxes: BoxHeader[] = [];
  let offset = 0;
  let ftyp: FtypInfo | null = null;
  let meta: IsobmffFile['meta'] = null;
  let mdat: IsobmffFile['mdat'] = null;
  while (offset < reader.size) {
    const header = await readBoxHeader(reader, offset, reader.size);
    if (!header) break;
    boxes.push(header);
    if (header.type === 'ftyp') {
      const payload = await reader.read(header.offset + header.headerSize, header.size - header.headerSize);
      ftyp = parseFtyp(payload);
    } else if (header.type === 'meta') {
      const payloadSize = header.size - header.headerSize;
      if (payloadSize > 16 * 1024 * 1024) {
        throw new AvifValidationError('META_TOO_LARGE', 'meta box 过大');
      }
      const payload = await reader.read(header.offset + header.headerSize, payloadSize);
      meta = parseMeta(payload);
      meta.offset = header.offset;
      meta.size = header.size;
    } else if (header.type === 'mdat') {
      mdat = { offset: header.offset, size: header.size };
    }
    offset += header.size;
  }
  if (offset !== reader.size) {
    throw new AvifValidationError('TRAILING_DATA', '文件末尾存在多余数据');
  }
  return { size: reader.size, boxes, ftyp, meta, mdat };
}

export function parseAv1C(raw: Uint8Array): Av1Config {
  if (raw.byteLength < 4) throw new AvifValidationError('INVALID_AV1C', 'av1C 太短');
  const b1 = raw[1]!;
  const b2 = raw[2]!;
  const b3 = raw[3]!;
  const seqProfile = b1 >> 5;
  const seqLevelIdx0 = b1 & 0x1f;
  const seqTier0 = b2 >> 7;
  const highBitdepth = (b2 >> 6) & 1;
  const twelveBit = (b2 >> 5) & 1;
  const monochrome = (b2 >> 4) & 1;
  const chromaSubsamplingX = (b2 >> 3) & 1;
  const chromaSubsamplingY = (b2 >> 2) & 1;
  const chromaSamplePosition = b2 & 0x03;
  const bitDepth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
  let chroma: 400 | 420 | 422 | 444;
  if (monochrome) chroma = 400;
  else if (chromaSubsamplingX && chromaSubsamplingY) chroma = 420;
  else if (chromaSubsamplingX) chroma = 422;
  else chroma = 444;
  const configObus = raw.subarray(4);
  void b3;
  return {
    seqProfile,
    seqLevelIdx0,
    seqTier0,
    highBitdepth: highBitdepth === 1,
    twelveBit: twelveBit === 1,
    monochrome: monochrome === 1,
    chromaSubsamplingX: chromaSubsamplingX === 1,
    chromaSubsamplingY: chromaSubsamplingY === 1,
    chromaSamplePosition,
    bitDepth,
    chroma,
    configObus,
  };
}

export function parseNclx(raw: Uint8Array): NclxColor | null {
  if (raw.byteLength < 4) return null;
  const type = fourcc(raw, 0);
  if (type !== 'nclx') return null;
  if (raw.byteLength < 11) return null;
  return {
    primaries: u16(raw, 4),
    transfer: u16(raw, 6),
    matrix: u16(raw, 8),
    fullRange: (raw[10]! & 0x80) !== 0,
  };
}

export function parseClli(raw: Uint8Array): ContentLightLevel | null {
  if (raw.byteLength < 4) return null;
  return {
    maxContentLightLevel: u16(raw, 0),
    maxPicAverageLightLevel: u16(raw, 2),
  };
}

export function parseMdcv(raw: Uint8Array): MasteringDisplay | null {
  if (raw.byteLength < 24) return null;
  const primaries: Array<[number, number]> = [];
  for (let i = 0; i < 3; i++) {
    primaries.push([u16(raw, i * 4), u16(raw, i * 4 + 2)]);
  }
  return {
    primaries,
    whitePoint: [u16(raw, 12), u16(raw, 14)],
    maxLuminance: u32(raw, 16),
    minLuminance: u32(raw, 20),
  };
}

function propertyFor(
  meta: NonNullable<IsobmffFile['meta']>,
  itemId: number,
  type: string,
): PropertyBox | null {
  for (const assoc of meta.associations) {
    if (assoc.itemId !== itemId) continue;
    const prop = meta.properties.find((p) => p.index === assoc.propertyIndex);
    if (prop && prop.type === type) return prop;
  }
  return null;
}

function propertiesFor(
  meta: NonNullable<IsobmffFile['meta']>,
  itemId: number,
): PropertyBox[] {
  const result: PropertyBox[] = [];
  for (const assoc of meta.associations) {
    if (assoc.itemId !== itemId) continue;
    const prop = meta.properties.find((p) => p.index === assoc.propertyIndex);
    if (prop) result.push(prop);
  }
  return result;
}

function ispeDimensions(raw: Uint8Array): { width: number; height: number } | null {
  if (raw.byteLength < 12) return null;
  return { width: u32(raw, 4), height: u32(raw, 8) };
}

async function readItemData(
  reader: Reader,
  file: IsobmffFile,
  location: ItemLocation,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const extent of location.extents) {
    let absolute: number;
    if (location.constructionMethod === 0) {
      absolute = location.baseOffset + extent.offset;
    } else if (location.constructionMethod === 1) {
      if (!file.meta?.idat) {
        throw new AvifValidationError('INVALID_ILOC', '缺少 idat');
      }
      absolute = -1;
    } else {
      throw new AvifValidationError('UNSUPPORTED_CONSTRUCTION', '不支持的 iloc construction_method');
    }
    if (absolute >= 0) {
      if (absolute + extent.length > reader.size) {
        throw new AvifValidationError('INVALID_ILOC', 'iloc extent 超出文件范围');
      }
      chunks.push(await reader.read(absolute, extent.length));
    } else {
      const idat = file.meta!.idat!;
      const start = location.baseOffset + extent.offset;
      if (start + extent.length > idat.byteLength) {
        throw new AvifValidationError('INVALID_ILOC', 'idat extent 超出范围');
      }
      chunks.push(idat.subarray(start, start + extent.length));
    }
    total += extent.length;
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of chunks) {
    out.set(chunk, p);
    p += chunk.byteLength;
  }
  return out;
}

function itemSize(file: IsobmffFile, id: number): number {
  const loc = file.meta?.locations.find((l) => l.id === id);
  if (!loc) return 0;
  return loc.extents.reduce((sum, e) => sum + e.length, 0);
}

function isHdrColor(color: NclxColor | null, bitDepth: number, clli: ContentLightLevel | null, mdcv: MasteringDisplay | null): boolean {
  if (clli || mdcv) return true;
  if (color) return color.transfer === 16 || color.transfer === 18;
  return bitDepth > 8;
}

export interface AvifValidationOptions {
  kind: 'full' | 'thumb';
  maxDimension: number;
  maxPixels: number;
  maxBytes: number;
}

export async function validateAvif(
  reader: Reader,
  options: AvifValidationOptions,
): Promise<AvifInfo> {
  if (reader.size > options.maxBytes) {
    throw new AvifValidationError('FILE_TOO_LARGE', '文件超过大小限制');
  }
  const file = await parseIsobmff(reader);
  if (!file.ftyp) throw new AvifValidationError('INVALID_FTYP', '缺少 ftyp');
  const brands = [file.ftyp.majorBrand, ...file.ftyp.compatibleBrands];
  if (brands.includes('avis')) {
    throw new AvifValidationError('UNSUPPORTED_FORMAT', '不支持动画 AVIF');
  }
  if (!brands.includes('avif')) {
    throw new AvifValidationError('UNSUPPORTED_FORMAT', '不是 AVIF 文件');
  }
  if (!file.meta) throw new AvifValidationError('INVALID_AVIF', '缺少 meta box');
  if (!file.mdat || file.mdat.size <= 8) {
    throw new AvifValidationError('INVALID_AVIF', '缺少 mdat 或 mdat 为空');
  }
  const meta = file.meta;
  if (meta.primaryItemId === null) {
    throw new AvifValidationError('INVALID_AVIF', '缺少 pitm');
  }
  if (meta.items.length === 0) {
    throw new AvifValidationError('INVALID_AVIF', '缺少 iinf');
  }
  if (meta.locations.length === 0) {
    throw new AvifValidationError('INVALID_AVIF', '缺少 iloc');
  }
  if (meta.properties.length === 0) {
    throw new AvifValidationError('INVALID_AVIF', '缺少 iprp/ipco');
  }
  const primary = meta.items.find((i) => i.id === meta.primaryItemId);
  if (!primary) throw new AvifValidationError('INVALID_AVIF', '主 item 不存在');
  if (primary.type !== 'av01' && primary.type !== 'grid') {
    throw new AvifValidationError('INVALID_AVIF', `主 item 类型不支持: ${primary.type}`);
  }

  for (const loc of meta.locations) {
    if (loc.dataReferenceIndex !== 0) {
      throw new AvifValidationError('INVALID_ILOC', '不支持外部 data reference');
    }
    if (loc.constructionMethod === 2) {
      throw new AvifValidationError('UNSUPPORTED_CONSTRUCTION', '不支持 construction_method=2');
    }
    if (loc.constructionMethod === 1 && !meta.idat) {
      throw new AvifValidationError('INVALID_ILOC', '缺少 idat');
    }
    for (const extent of loc.extents) {
      if (loc.constructionMethod === 0) {
        const absolute = loc.baseOffset + extent.offset;
        if (absolute + extent.length > reader.size) {
          throw new AvifValidationError('INVALID_ILOC', 'iloc extent 超出文件范围');
        }
      } else if (loc.constructionMethod === 1) {
        const start = loc.baseOffset + extent.offset;
        if (start + extent.length > (meta.idat?.byteLength ?? 0)) {
          throw new AvifValidationError('INVALID_ILOC', 'idat extent 超出范围');
        }
      }
    }
  }

  let width = 0;
  let height = 0;
  let isGrid = false;
  let tileCount = 0;
  let av1c: Av1Config | null = null;
  let color: NclxColor | null = null;
  let clli: ContentLightLevel | null = null;
  let mdcv: MasteringDisplay | null = null;
  let rotation = 0;
  let mirror = 0;
  let hasIcc = false;

  const primaryProps = propertiesFor(meta, primary.id);
  for (const prop of primaryProps) {
    if (prop.type === 'colr') {
      const nclx = parseNclx(prop.raw.subarray(8));
      if (nclx) color = nclx;
      else hasIcc = true;
    } else if (prop.type === 'clli') {
      clli = parseClli(prop.raw.subarray(8));
    } else if (prop.type === 'mdcv') {
      mdcv = parseMdcv(prop.raw.subarray(8));
    } else if (prop.type === 'irot') {
      rotation = (prop.raw[8] ?? 0) & 0x03;
    } else if (prop.type === 'imir') {
      mirror = (prop.raw[8] ?? 0) & 0x01;
    }
  }

  if (primary.type === 'grid') {
    isGrid = true;
    const loc = meta.locations.find((l) => l.id === primary.id);
    if (!loc) throw new AvifValidationError('INVALID_GRID', 'grid item 缺少 iloc');
    const data = await readItemData(reader, file, loc);
    if (data.byteLength < 8) throw new AvifValidationError('INVALID_GRID', 'grid 数据太短');
    const rows = data[2]! + 1;
    const cols = data[3]! + 1;
    width = u16(data, 4);
    height = u16(data, 6);
    tileCount = rows * cols;
    if (data.byteLength < 8 + tileCount * 2) {
      throw new AvifValidationError('INVALID_GRID', 'grid tile 列表不完整');
    }
    const tileIds: number[] = [];
    for (let i = 0; i < tileCount; i++) tileIds.push(u16(data, 8 + i * 2));
    for (const tileId of tileIds) {
      const tile = meta.items.find((i) => i.id === tileId);
      if (!tile || tile.type !== 'av01') {
        throw new AvifValidationError('INVALID_GRID', 'grid 引用了不存在的 tile');
      }
      if (!av1c) {
        const prop = propertyFor(meta, tileId, 'av1C');
        if (prop) av1c = parseAv1C(prop.raw.subarray(8));
      }
    }
    if (!av1c) throw new AvifValidationError('INVALID_AVIF', 'grid tile 缺少 av1C');
  } else {
    const ispe = propertyFor(meta, primary.id, 'ispe');
    if (!ispe) throw new AvifValidationError('INVALID_AVIF', '缺少 ispe');
    const dims = ispeDimensions(ispe.raw.subarray(8));
    if (!dims) throw new AvifValidationError('INVALID_AVIF', 'ispe 非法');
    width = dims.width;
    height = dims.height;
    const av1cProp = propertyFor(meta, primary.id, 'av1C');
    if (!av1cProp) throw new AvifValidationError('INVALID_AVIF', '缺少 av1C');
    av1c = parseAv1C(av1cProp.raw.subarray(8));
  }

  if (!av1c) throw new AvifValidationError('INVALID_AVIF', '缺少 av1C');
  if (width <= 0 || height <= 0) {
    throw new AvifValidationError('INVALID_AVIF', '图片尺寸非法');
  }
  if (width > options.maxDimension || height > options.maxDimension) {
    throw new AvifValidationError('INVALID_AVIF', '图片尺寸超过限制');
  }
  if (width * height > options.maxPixels) {
    throw new AvifValidationError('INVALID_AVIF', '图片像素数超过限制');
  }

  const pixi = propertyFor(meta, primary.id, 'pixi');
  if (pixi) {
    const body = pixi.raw.subarray(8);
    if (body.byteLength >= 2) {
      const channels = body[1]!;
      for (let i = 0; i < channels; i++) {
        const bits = body[2 + i];
        if (bits !== undefined && bits !== av1c.bitDepth) {
          throw new AvifValidationError('INVALID_AVIF', 'pixi 位深与 av1C 不一致');
        }
      }
    }
  }

  const hasAlpha = meta.items.some((i) => i.type === 'auxl') ||
    meta.references.some((r) => r.type === 'auxl' && r.fromItemId === primary.id);
  const hasExif = meta.items.some((i) => i.type === 'Exif');
  const hasXmp = meta.items.some((i) => i.type === 'mime' && /xmp/i.test(i.name));
  for (const item of meta.items) {
    if (item.type === 'Exif' || item.type === 'mime') {
      if (itemSize(file, item.id) > 1024 * 1024) {
        throw new AvifValidationError('INVALID_AVIF', '元数据 item 超过 1MB');
      }
    }
  }

  if (options.kind === 'thumb') {
    if (width !== 600 || height !== 600) {
      throw new AvifValidationError('INVALID_THUMBNAIL', '缩略图必须是 600×600');
    }
    if (av1c.bitDepth !== 8) {
      throw new AvifValidationError('INVALID_THUMBNAIL', '缩略图必须是 8-bit');
    }
    if (av1c.chroma !== 420) {
      throw new AvifValidationError('INVALID_THUMBNAIL', '缩略图必须是 4:2:0');
    }
    if (av1c.monochrome) {
      throw new AvifValidationError('INVALID_THUMBNAIL', '缩略图不能是单色');
    }
  }

  const isHdr =
    isHdrColor(color, av1c.bitDepth, clli, mdcv) ||
    (av1c.bitDepth > 8 && (!color || color.transfer === 2));
  return {
    width,
    height,
    bitDepth: av1c.bitDepth,
    chroma: av1c.chroma,
    monochrome: av1c.monochrome,
    hasAlpha,
    isHdr,
    color,
    hasIcc,
    hasExif,
    hasXmp,
    primaryItemType: primary.type,
    isGrid,
    tileCount,
    rotation,
    mirror,
    clli,
    mdcv,
    items: meta.items,
    warnings: [],
  };
}

export async function parseHeif(reader: Reader): Promise<HeifInfo> {
  const file = await parseIsobmff(reader);
  if (!file.ftyp) throw new AvifValidationError('INVALID_FTYP', '缺少 ftyp');
  if (!file.meta) throw new AvifValidationError('INVALID_HEIF', '缺少 meta');
  const meta = file.meta;
  if (meta.primaryItemId === null) throw new AvifValidationError('INVALID_HEIF', '缺少 pitm');
  const primary = meta.items.find((i) => i.id === meta.primaryItemId);
  if (!primary) throw new AvifValidationError('INVALID_HEIF', '主 item 不存在');
  let width = 0;
  let height = 0;
  const ispe = propertyFor(meta, primary.id, 'ispe');
  if (ispe) {
    const dims = ispeDimensions(ispe.raw.subarray(8));
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  }
  let bitDepth = 8;
  let chroma: 400 | 420 | 422 | 444 = 420;
  const hvcC = propertyFor(meta, primary.id, 'hvcC');
  if (hvcC) {
    const body = hvcC.raw.subarray(8);
    if (body.byteLength >= 18) {
      const chromaFormat = body[16]! & 0x03;
      const lumaMinus8 = body[17]! & 0x07;
      bitDepth = 8 + lumaMinus8;
      chroma = chromaFormat === 0 ? 400 : chromaFormat === 1 ? 420 : chromaFormat === 2 ? 422 : 444;
    }
  }
  let color: NclxColor | null = null;
  let hasIcc = false;
  for (const prop of propertiesFor(meta, primary.id)) {
    if (prop.type === 'colr') {
      const nclx = parseNclx(prop.raw.subarray(8));
      if (nclx) color = nclx;
      else hasIcc = true;
    }
  }
  const hasExif = meta.items.some((i) => i.type === 'Exif');
  return {
    width,
    height,
    bitDepth,
    chroma,
    isHdr: color ? color.transfer === 16 || color.transfer === 18 : bitDepth > 8,
    color,
    hasIcc,
    hasExif,
    primaryItemType: primary.type,
    brand: file.ftyp.majorBrand,
    compatibleBrands: file.ftyp.compatibleBrands,
    items: meta.items,
  };
}

export { readItemData, itemSize, propertyFor, propertiesFor, ispeDimensions };
