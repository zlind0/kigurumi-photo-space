import type { Role, Tier, Visibility } from '../../shared/types.js';

const RANK: Record<Role, number> = {
  public: 0,
  viewer: 1,
  uploader: 2,
  admin: 3,
};

export function roleAtLeast(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

export function canViewAlbum(album: { visibility: Visibility }, role: Role): boolean {
  return album.visibility === 'public' || roleAtLeast(role, 'viewer');
}

export function canViewPhoto(photo: { visibility: Visibility }, role: Role): boolean {
  return photo.visibility === 'public' || roleAtLeast(role, 'viewer');
}

export function canUpload(role: Role): boolean {
  return roleAtLeast(role, 'uploader');
}

export function canCreateAlbum(role: Role): boolean {
  return roleAtLeast(role, 'uploader');
}

export function canManageAlbum(role: Role): boolean {
  return role === 'admin';
}

export function canSetVisibility(role: Role): boolean {
  return role === 'admin';
}

export function canManagePhoto(
  role: Role,
  photo: { upload_session_id: string | null },
  sessionId: string | null,
): boolean {
  if (role === 'admin') return true;
  if (!roleAtLeast(role, 'uploader')) return false;
  return Boolean(sessionId && photo.upload_session_id === sessionId);
}

export function canSetTier(
  role: Role,
  photo: { upload_session_id: string | null },
  sessionId: string | null,
): boolean {
  return canManagePhoto(role, photo, sessionId);
}

export function canSetPhotoVisibility(role: Role): boolean {
  return role === 'admin';
}

export function tierDirectory(tier: Tier, visibility: Visibility): 'top' | 'others' | 'hidden' {
  if (visibility === 'private') return 'hidden';
  return tier === 'other' ? 'others' : 'top';
}
