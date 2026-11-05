import {
  bufferReader,
  parseIsobmff,
  readItemData,
} from './parse.js';
import { AvifValidationError, type IsobmffFile } from './types.js';

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.byteLength;
  }
  return out;
}

function u8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function u64(n: number): Uint8Array {
  return concat([u32(Math.floor(n / 0x100000000)), u32(n >>> 0)]);
}

function fourcc(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i) & 0xff;
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.byteLength + 8), fourcc(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat([u8(version), u8((flags >> 16) & 0xff), u8((flags >> 8) & 0xff), u8(flags & 0xff), ...parts]);
  return concat([u32(body.byteLength + 8), fourcc(type), body]);
}

function cstring(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return concat([bytes, new Uint8Array([0])]);
}

export interface Av1ConfigInput {
  seqProfile: number;
  seqLevelIdx0: number;
  seqTier0: number;
  highBitdepth: boolean;
  twelveBit: boolean;
  monochrome: boolean;
  chromaSubsamplingX: boolean;
  chromaSubsamplingY: boolean;
  chromaSamplePosition: number;
  configObus: Uint8Array;
}

export function buildAv1C(config: Av1ConfigInput): Uint8Array {
  const marker = 0x81;
  const b1 = ((config.seqProfile & 0x07) << 5) | (config.seqLevelIdx0 & 0x1f);
  const b2 =
    ((config.seqTier0 & 1) << 7) |
    ((config.highBitdepth ? 1 : 0) << 6) |
    ((config.twelveBit ? 1 : 0) << 5) |
    ((config.monochrome ? 1 : 0) << 4) |
    ((config.chromaSubsamplingX ? 1 : 0) << 3) |
    ((config.chromaSubsamplingY ? 1 : 0) << 2) |
    (config.chromaSamplePosition & 0x03);
  const b3 = 0x00;
  return box('av1C', new Uint8Array([marker, b1, b2, b3]), config.configObus);
}

export interface BuildAvifOptions {
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  chroma: 400 | 420 | 422 | 444;
  monochrome?: boolean;
  av1c: Av1ConfigInput;
  frameData: Uint8Array;
  color: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
  clli?: { maxContentLightLevel: number; maxPicAverageLightLevel: number } | null;
  mdcv?: {
    primaries: Array<[number, number]>;
    whitePoint: [number, number];
    maxLuminance: number;
    minLuminance: number;
  } | null;
  exifTiff?: Uint8Array | null;
  rotation?: number;
  mirror?: number;
}

function buildIspe(width: number, height: number): Uint8Array {
  return fullBox('ispe', 0, 0, u32(width), u32(height));
}

function buildPixi(channels: number, bitDepth: number): Uint8Array {
  const bits = new Uint8Array(channels);
  bits.fill(bitDepth);
  return fullBox('pixi', 0, 0, u8(channels), bits);
}

function buildColr(color: BuildAvifOptions['color']): Uint8Array {
  return box(
    'colr',
    fourcc('nclx'),
    u16(color.primaries),
    u16(color.transfer),
    u16(color.matrix),
    u8(color.fullRange ? 0x80 : 0x00),
  );
}

function buildClli(clli: NonNullable<BuildAvifOptions['clli']>): Uint8Array {
  return box('clli', u16(clli.maxContentLightLevel), u16(clli.maxPicAverageLightLevel));
}

function buildMdcv(mdcv: NonNullable<BuildAvifOptions['mdcv']>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [x, y] of mdcv.primaries) parts.push(u16(x), u16(y));
  parts.push(u16(mdcv.whitePoint[0]), u16(mdcv.whitePoint[1]));
  parts.push(u32(mdcv.maxLuminance), u32(mdcv.minLuminance));
  return box('mdcv', ...parts);
}

function buildIrot(angle: number): Uint8Array {
  return box('irot', u8(angle & 0x03));
}

function buildImir(axis: number): Uint8Array {
  return box('imir', u8(axis & 0x01));
}

function buildInfe(itemId: number, itemType: string, name: string): Uint8Array {
  return fullBox('infe', 2, 0, u16(itemId), u16(0), fourcc(itemType), cstring(name));
}

function buildIloc(
  entries: Array<{ id: number; constructionMethod: number; extents: Array<{ offset: number; length: number }> }>,
): Uint8Array {
  const use32 = entries.some((e) => e.id > 0xffff);
  const version = use32 ? 2 : 0;
  const parts: Uint8Array[] = [];
  parts.push(u8(0x44)); // offset_size=4, length_size=4
  parts.push(u8(0x00)); // base_offset_size=0, index_size=0
  parts.push(use32 ? u32(entries.length) : u16(entries.length));
  for (const entry of entries) {
    parts.push(use32 ? u32(entry.id) : u16(entry.id));
    if (version >= 1) parts.push(u16(entry.constructionMethod & 0x0f));
    parts.push(u16(0)); // data_reference_index
    parts.push(u16(entry.extents.length));
    for (const extent of entry.extents) {
      parts.push(u32(extent.offset), u32(extent.length));
    }
  }
  return fullBox('iloc', version, 0, ...parts);
}

function buildIinf(items: Array<{ id: number; type: string; name: string }>): Uint8Array {
  const use32 = items.some((i) => i.id > 0xffff);
  const parts: Uint8Array[] = [];
  parts.push(use32 ? u32(items.length) : u16(items.length));
  for (const item of items) {
    parts.push(buildInfe(item.id, item.type, item.name));
  }
  return fullBox('iinf', use32 ? 1 : 0, 0, ...parts);
}

function buildIref(refs: Array<{ type: string; from: number; to: number[] }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const ref of refs) {
    const body = concat([
      fourcc(ref.type),
      u16(ref.from),
      u16(ref.to.length),
      ...ref.to.map((id) => u16(id)),
    ]);
    parts.push(concat([u32(body.byteLength + 4), body]));
  }
  return fullBox('iref', 0, 0, ...parts);
}

function buildIpco(properties: Uint8Array[]): Uint8Array {
  return box('ipco', ...properties);
}

function buildIpma(associations: Array<{ itemId: number; essential: boolean; index: number }>): Uint8Array {
  const byItem = new Map<number, Array<{ essential: boolean; index: number }>>();
  for (const assoc of associations) {
    const list = byItem.get(assoc.itemId) ?? [];
    list.push({ essential: assoc.essential, index: assoc.index });
    byItem.set(assoc.itemId, list);
  }
  const parts: Uint8Array[] = [u32(byItem.size)];
  for (const [itemId, list] of byItem) {
    parts.push(u16(itemId), u8(list.length));
    for (const assoc of list) {
      parts.push(u8((assoc.essential ? 0x80 : 0) | (assoc.index & 0x7f)));
    }
  }
  return fullBox('ipma', 0, 0, ...parts);
}

function buildHdlr(): Uint8Array {
  return fullBox('hdlr', 0, 0, u32(0), fourcc('pict'), u32(0), u32(0), u32(0), cstring('PictureHandler'));
}

function buildPitm(itemId: number): Uint8Array {
  return fullBox('pitm', 0, 0, u16(itemId));
}

function buildMeta(children: Uint8Array[]): Uint8Array {
  return fullBox('meta', 0, 0, ...children);
}

function buildFtyp(bitDepth: number, chroma: number): Uint8Array {
  const profile = chroma === 444 ? 'MA1A' : 'MA1B';
  void bitDepth;
  return box('ftyp', fourcc('avif'), u32(0), fourcc('avif'), fourcc('mif1'), fourcc('miaf'), fourcc(profile));
}

export function buildAvif(options: BuildAvifOptions): Uint8Array {
  const exifItemId = 2;
  const exifData = options.exifTiff
    ? concat([u32(0), options.exifTiff])
    : null;

  const properties: Uint8Array[] = [];
  const associations: Array<{ itemId: number; essential: boolean; index: number }> = [];
  const addProperty = (raw: Uint8Array, essential = true) => {
    properties.push(raw);
    associations.push({ itemId: 1, essential, index: properties.length });
  };

  addProperty(buildAv1C(options.av1c));
  addProperty(buildIspe(options.width, options.height));
  addProperty(buildPixi(options.monochrome ? 1 : 3, options.bitDepth));
  addProperty(buildColr(options.color));
  if (options.clli) addProperty(buildClli(options.clli));
  if (options.mdcv) addProperty(buildMdcv(options.mdcv));
  if (options.rotation) addProperty(buildIrot(options.rotation));
  if (options.mirror) addProperty(buildImir(options.mirror));

  const items = [{ id: 1, type: 'av01', name: 'Color' }];
  if (exifData) items.push({ id: exifItemId, type: 'Exif', name: 'Exif' });

  const refs = exifData ? [{ type: 'cdsc', from: exifItemId, to: [1] }] : [];

  const buildMetaWithOffsets = (mdatDataOffset: number): Uint8Array => {
    const ilocEntries = [
      { id: 1, constructionMethod: 0, extents: [{ offset: mdatDataOffset, length: options.frameData.byteLength }] },
    ];
    if (exifData) {
      ilocEntries.push({
        id: exifItemId,
        constructionMethod: 0,
        extents: [{ offset: mdatDataOffset + options.frameData.byteLength, length: exifData.byteLength }],
      });
    }
    const children = [
      buildHdlr(),
      buildPitm(1),
      buildIloc(ilocEntries),
      buildIinf(items),
      ...(refs.length ? [buildIref(refs)] : []),
      box('iprp', buildIpco(properties), buildIpma(associations)),
    ];
    return buildMeta(children);
  };

  const ftyp = buildFtyp(options.bitDepth, options.chroma);
  const placeholderMeta = buildMetaWithOffsets(0);
  const mdatDataOffset = ftyp.byteLength + placeholderMeta.byteLength + 8;
  const meta = buildMetaWithOffsets(mdatDataOffset);
  const mdat = box('mdat', options.frameData, ...(exifData ? [exifData] : []));
  return concat([ftyp, meta, mdat]);
}

function readU16(data: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? data[offset]! | (data[offset + 1]! << 8)
    : (data[offset]! << 8) | data[offset + 1]!;
}

function writeU16(data: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  if (littleEndian) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
  } else {
    data[offset] = (value >> 8) & 0xff;
    data[offset + 1] = value & 0xff;
  }
}

function readU32(data: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0
    : ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

export function setTiffOrientation(tiff: Uint8Array, orientation = 1): Uint8Array {
  const out = tiff.slice();
  if (out.byteLength < 8) return out;
  const littleEndian = out[0] === 0x49 && out[1] === 0x49;
  const bigEndian = out[0] === 0x4d && out[1] === 0x4d;
  if (!littleEndian && !bigEndian) return out;
  const le = littleEndian;
  if (readU16(out, 2, le) !== 42) return out;
  const ifdOffset = readU32(out, 4, le);
  if (ifdOffset + 2 > out.byteLength) return out;
  const count = readU16(out, ifdOffset, le);
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > out.byteLength) break;
    const tag = readU16(out, entry, le);
    if (tag !== 0x0112) continue;
    const type = readU16(out, entry + 2, le);
    const valueCount = readU32(out, entry + 4, le);
    if (type === 3 && valueCount >= 1) {
      writeU16(out, entry + 8, orientation, le);
    }
    return out;
  }
  return out;
}

function findChild(file: IsobmffFile, type: string): Uint8Array | null {
  return file.meta?.rawChildren.find((c) => c.type === type)?.raw ?? null;
}

function incrementIinf(raw: Uint8Array, extra: Uint8Array): Uint8Array {
  const version = raw[8]!;
  const countOffset = 12;
  const countSize = version === 0 ? 2 : 4;
  const count = version === 0 ? readU16(raw, countOffset, false) : readU32(raw, countOffset, false);
  const next = raw.slice();
  if (version === 0) writeU16(next, countOffset, count + 1, false);
  else {
    const value = count + 1;
    next[countOffset] = (value >>> 24) & 0xff;
    next[countOffset + 1] = (value >>> 16) & 0xff;
    next[countOffset + 2] = (value >>> 8) & 0xff;
    next[countOffset + 3] = value & 0xff;
  }
  const body = concat([next.subarray(8), extra]);
  const out = concat([u32(body.byteLength + 8), fourcc('iinf'), body]);
  void countSize;
  return out;
}

function appendIref(raw: Uint8Array | null, ref: Uint8Array): Uint8Array {
  if (!raw) {
    return fullBox('iref', 0, 0, ref);
  }
  const body = concat([raw.subarray(8), ref]);
  return concat([u32(body.byteLength + 8), fourcc('iref'), body]);
}

export async function injectExif(avif: Uint8Array, tiff: Uint8Array): Promise<Uint8Array> {
  const reader = bufferReader(avif);
  const file = await parseIsobmff(reader);
  if (!file.meta || !file.ftyp) {
    throw new AvifValidationError('INVALID_AVIF', '无法解析 AVIF 容器');
  }
  const meta = file.meta;
  if (meta.items.some((item) => item.type === 'Exif')) return avif;
  if (meta.primaryItemId === null) {
    throw new AvifValidationError('INVALID_AVIF', '缺少主 item');
  }
  const primaryId = meta.primaryItemId;
  const exifId = Math.max(0, ...meta.items.map((item) => item.id)) + 1;
  if (exifId > 0xffff) {
    throw new AvifValidationError('UNSUPPORTED_CONSTRUCTION', 'item ID 过大');
  }

  const itemData = new Map<number, Uint8Array>();
  for (const loc of meta.locations) {
    if (loc.constructionMethod === 0) {
      itemData.set(loc.id, await readItemData(reader, file, loc));
    } else if (loc.constructionMethod === 1) {
      // data stays in idat
    } else {
      throw new AvifValidationError('UNSUPPORTED_CONSTRUCTION', '不支持 construction_method=2');
    }
  }

  const exifData = concat([u32(0), tiff]);
  const ftypRaw = file.boxes.find((b) => b.type === 'ftyp');
  if (!ftypRaw) throw new AvifValidationError('INVALID_FTYP', '缺少 ftyp');
  const ftyp = avif.subarray(ftypRaw.offset, ftypRaw.offset + ftypRaw.size);

  const buildMetaWithOffsets = (mdatDataOffset: number): Uint8Array => {
    let running = 0;
    const ilocEntries: Array<{
      id: number;
      constructionMethod: number;
      extents: Array<{ offset: number; length: number }>;
    }> = [];
    for (const loc of meta.locations) {
      if (loc.constructionMethod === 0) {
        const data = itemData.get(loc.id);
        if (!data) continue;
        ilocEntries.push({
          id: loc.id,
          constructionMethod: 0,
          extents: [{ offset: mdatDataOffset + running, length: data.byteLength }],
        });
        running += data.byteLength;
      } else {
        ilocEntries.push({
          id: loc.id,
          constructionMethod: 1,
          extents: loc.extents.map((e) => ({ offset: e.offset, length: e.length })),
        });
      }
    }
    ilocEntries.push({
      id: exifId,
      constructionMethod: 0,
      extents: [{ offset: mdatDataOffset + running, length: exifData.byteLength }],
    });

    const children: Uint8Array[] = [];
    const hdlr = findChild(file, 'hdlr');
    const pitm = findChild(file, 'pitm');
    const iprp = findChild(file, 'iprp');
    const idat = findChild(file, 'idat');
    if (hdlr) children.push(hdlr);
    if (pitm) children.push(pitm);
    children.push(buildIloc(ilocEntries));
    const iinf = findChild(file, 'iinf');
    if (!iinf) throw new AvifValidationError('INVALID_AVIF', '缺少 iinf');
    children.push(incrementIinf(iinf, buildInfe(exifId, 'Exif', 'Exif')));
    const iref = findChild(file, 'iref');
    const refBody = concat([fourcc('cdsc'), u16(exifId), u16(1), u16(primaryId)]);
    children.push(appendIref(iref, concat([u32(refBody.byteLength + 4), refBody])));
    if (iprp) children.push(iprp);
    if (idat) children.push(idat);
    for (const child of meta.rawChildren) {
      if (['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat'].includes(child.type)) continue;
      children.push(child.raw);
    }
    return buildMeta(children);
  };

  const placeholderMeta = buildMetaWithOffsets(0);
  const mdatDataOffset = ftyp.byteLength + placeholderMeta.byteLength + 8;
  const newMeta = buildMetaWithOffsets(mdatDataOffset);

  const mdatParts: Uint8Array[] = [];
  for (const loc of meta.locations) {
    if (loc.constructionMethod !== 0) continue;
    const data = itemData.get(loc.id);
    if (data) mdatParts.push(data);
  }
  mdatParts.push(exifData);
  const mdat = box('mdat', ...mdatParts);
  return concat([ftyp, newMeta, mdat]);
}
