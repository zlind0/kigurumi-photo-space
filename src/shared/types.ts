export type Role = 'public' | 'viewer' | 'uploader' | 'admin';
export type UserRole = Exclude<Role, 'public'>;
export type Visibility = 'public' | 'private';
export type Tier = 'cover' | 'featured' | 'other';

export interface PhotoDTO {
  id: number;
  albumId: number;
  md5: string;
  width: number;
  height: number;
  tier: Tier;
  visibility: Visibility;
  createdAt: number;
  originalName: string | null;
  thumbUrl: string;
  fullUrl: string;
  bitDepth: number;
  isHdr: boolean;
  hasAlpha: boolean;
  canDelete: boolean;
  canSetTier: boolean;
  canSetVisibility: boolean;
}

export interface CoverDTO {
  photoId: number;
  thumbUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  isHdr: boolean;
}

export interface AlbumDTO {
  id: number;
  name: string;
  dir: string;
  visibility: Visibility;
  createdAt: number;
  photoCount: number;
  cover: CoverDTO | null;
  canUpload: boolean;
  canManage: boolean;
}

export interface PermissionsDTO {
  canUpload: boolean;
  canCreateAlbum: boolean;
  canManageAlbum: boolean;
  canSetTier: boolean;
  canSetVisibility: boolean;
}

export interface MeDTO {
  authenticated: boolean;
  user: { id: number; role: UserRole } | null;
  session: { expiresAt: number } | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

export interface UploadMeta {
  originalName?: string;
  width?: number;
  height?: number;
  md5?: string;
  thumbMd5?: string;
  bitDepth?: number;
  isHdr?: boolean;
  hasAlpha?: boolean;
  colorPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  exifPreserved?: boolean;
  exifSummary?: Record<string, unknown> | null;
}

export interface UploadResponse {
  photo: PhotoDTO;
  deduped: boolean;
}

export interface AlbumListResponse {
  albums: AlbumDTO[];
  nextCursor: string | null;
}

export interface PhotoListResponse {
  items: PhotoDTO[];
  nextCursor: string | null;
}

export interface AlbumDetailResponse {
  album: AlbumDTO;
  cover: PhotoDTO | null;
  featured: PhotoDTO[];
  photos: PhotoListResponse;
  permissions: PermissionsDTO;
}

export interface AdminUserDTO {
  id: number;
  role: UserRole;
  createdAt: number;
  createdBy: number | null;
  lastLoginAt: number | null;
  disabled: boolean;
  note: string | null;
}

export interface AuditLogDTO {
  id: number;
  ts: number;
  userId: number | null;
  role: UserRole | null;
  sessionId: string | null;
  action: string;
  ip: string | null;
  userAgent: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
}

export interface AdminStats {
  albums: number;
  photos: number;
  users: number;
  totalBytes: number;
  diskFree: number;
  diskTotal: number;
}
