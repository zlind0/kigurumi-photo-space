import type { UploadMeta } from '../../shared/types.js';

export type InputFormat = 'avif' | 'heic' | 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff' | 'bmp' | 'unknown';

export type Stage =
  | 'detect'
  | 'decode'
  | 'resize'
  | 'encode-full'
  | 'encode-preview'
  | 'encode-thumb'
  | 'metadata'
  | 'done';

export interface ProcessOptions {
  maxDimension: number;
  maxPixels: number;
  fullQuality: number;
  previewQuality: number;
  previewMaxDimension: number;
  thumbQuality: number;
  speed: number;
}

export interface ProcessRequest {
  id: number;
  file: File;
  options: ProcessOptions;
}

export interface ProgressMessage {
  type: 'progress';
  id: number;
  stage: Stage;
  message: string;
}

export interface ResultMessage {
  type: 'result';
  id: number;
  full: ArrayBuffer;
  preview: ArrayBuffer;
  thumb: ArrayBuffer;
  meta: UploadMeta;
  warnings: string[];
  width: number;
  height: number;
  bitDepth: number;
  isHdr: boolean;
  hasAlpha: boolean;
  exifPreserved: boolean;
}

export interface ErrorMessage {
  type: 'error';
  id: number;
  error: string;
  code: string;
}

export type WorkerMessage = ProgressMessage | ResultMessage | ErrorMessage;
export type ProcessResult = ResultMessage;
