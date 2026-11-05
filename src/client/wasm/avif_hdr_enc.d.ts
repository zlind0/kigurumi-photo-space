export interface AvifHdrEncoderModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _kps_encode_av1_10bit(
    rgbaPtr: number,
    width: number,
    height: number,
    quality: number,
    speed: number,
    primaries: number,
    transfer: number,
    matrix: number,
    outDataPtr: number,
    outSizePtr: number,
  ): number;
  _kps_free(ptr: number): void;
}

export default function createAvifHdrEncoder(options?: unknown): Promise<AvifHdrEncoderModule>;
