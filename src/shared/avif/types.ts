export interface BoxHeader {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
}

export interface ItemInfo {
  id: number;
  type: string;
  name: string;
  protectionIndex: number;
}

export interface Extent {
  offset: number;
  length: number;
}

export interface ItemLocation {
  id: number;
  constructionMethod: number;
  dataReferenceIndex: number;
  baseOffset: number;
  extents: Extent[];
}

export interface PropertyBox {
  index: number;
  type: string;
  raw: Uint8Array;
}

export interface PropertyAssociation {
  itemId: number;
  essential: boolean;
  propertyIndex: number;
}

export interface ItemReference {
  type: string;
  fromItemId: number;
  toItemIds: number[];
}

export interface FtypInfo {
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: string[];
}

export interface IsobmffFile {
  size: number;
  boxes: BoxHeader[];
  ftyp: FtypInfo | null;
  meta: {
    offset: number;
    size: number;
    handlerType: string | null;
    primaryItemId: number | null;
    items: ItemInfo[];
    locations: ItemLocation[];
    properties: PropertyBox[];
    associations: PropertyAssociation[];
    references: ItemReference[];
    idat: Uint8Array | null;
    versionFlags: number;
    rawChildren: Array<{ type: string; raw: Uint8Array }>;
  } | null;
  mdat: { offset: number; size: number } | null;
}

export interface Av1Config {
  seqProfile: number;
  seqLevelIdx0: number;
  seqTier0: number;
  highBitdepth: boolean;
  twelveBit: boolean;
  monochrome: boolean;
  chromaSubsamplingX: boolean;
  chromaSubsamplingY: boolean;
  chromaSamplePosition: number;
  bitDepth: number;
  chroma: 400 | 420 | 422 | 444;
  configObus: Uint8Array;
}

export interface NclxColor {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export interface ContentLightLevel {
  maxContentLightLevel: number;
  maxPicAverageLightLevel: number;
}

export interface MasteringDisplay {
  primaries: Array<[number, number]>;
  whitePoint: [number, number];
  maxLuminance: number;
  minLuminance: number;
}

export interface AvifInfo {
  width: number;
  height: number;
  bitDepth: number;
  chroma: 400 | 420 | 422 | 444;
  monochrome: boolean;
  hasAlpha: boolean;
  isHdr: boolean;
  color: NclxColor | null;
  hasIcc: boolean;
  hasExif: boolean;
  hasXmp: boolean;
  primaryItemType: string;
  isGrid: boolean;
  tileCount: number;
  rotation: number;
  mirror: number;
  clli: ContentLightLevel | null;
  mdcv: MasteringDisplay | null;
  items: ItemInfo[];
  warnings: string[];
}

export interface HeifInfo {
  width: number;
  height: number;
  bitDepth: number;
  chroma: 400 | 420 | 422 | 444;
  isHdr: boolean;
  color: NclxColor | null;
  hasIcc: boolean;
  hasExif: boolean;
  primaryItemType: string;
  brand: string;
  compatibleBrands: string[];
  items: ItemInfo[];
}

export class AvifValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AvifValidationError';
    this.code = code;
  }
}
