import type { AlbumDTO, PermissionsDTO, PhotoDTO, Role } from '../../shared/types.js';
import { escapeHtml } from '../http/errors.js';
import { renderLayout, type AssetManifest } from './layout.js';

export interface AlbumPageOptions {
  album: AlbumDTO;
  cover: PhotoDTO | null;
  featured: PhotoDTO[];
  photos: PhotoDTO[];
  nextCursor: string | null;
  permissions: PermissionsDTO;
  role: Role;
  authenticated: boolean;
  manifest: AssetManifest;
}

function photoActions(photo: PhotoDTO): string {
  const actions: string[] = [];
  if (photo.canSetTier) {
    if (photo.tier !== 'cover') {
      actions.push(`<button type="button" class="mini-button" data-action="set-tier" data-tier="cover">设为封面</button>`);
    }
    if (photo.tier !== 'featured') {
      actions.push(`<button type="button" class="mini-button" data-action="set-tier" data-tier="featured">精选</button>`);
    }
    if (photo.tier !== 'other') {
      actions.push(`<button type="button" class="mini-button" data-action="set-tier" data-tier="other">其他</button>`);
    }
  }
  if (photo.canSetVisibility) {
    actions.push(
      `<button type="button" class="mini-button" data-action="set-visibility" data-visibility="${photo.visibility === 'public' ? 'private' : 'public'}">${photo.visibility === 'public' ? '设为私密' : '设为公开'}</button>`,
    );
  }
  if (photo.canDelete) {
    actions.push(`<button type="button" class="mini-button danger" data-action="delete-photo">删除</button>`);
  }
  return actions.length ? `<div class="photo-actions">${actions.join('')}</div>` : '';
}

function photoCard(photo: PhotoDTO, index: number, eager = false): string {
  const badges: string[] = [];
  if (photo.isHdr) badges.push('<span class="badge hdr">HDR</span>');
  if (photo.visibility === 'private') badges.push('<span class="badge private">私密</span>');
  if (photo.tier === 'cover') badges.push('<span class="badge cover">封面</span>');
  const loading = eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  return `<li class="photo-item" data-photo-id="${photo.id}" data-tier="${photo.tier}" data-visibility="${photo.visibility}" data-can-delete="${photo.canDelete ? '1' : '0'}" data-can-set-tier="${photo.canSetTier ? '1' : '0'}" data-can-set-visibility="${photo.canSetVisibility ? '1' : '0'}">
  <button class="photo-card" type="button" data-action="open-lightbox" data-full="${escapeHtml(photo.fullUrl)}" data-thumb="${escapeHtml(photo.thumbUrl)}" data-width="${photo.width}" data-height="${photo.height}" data-caption="${escapeHtml(photo.originalName ?? '')}" aria-label="查看照片 ${escapeHtml(photo.originalName ?? String(photo.id))}">
    <img src="${escapeHtml(photo.thumbUrl)}" alt="${escapeHtml(photo.originalName ?? '照片')}" width="600" height="600" ${loading}>
    ${badges.length ? `<span class="photo-badges">${badges.join('')}</span>` : ''}
  </button>
  ${photoActions(photo)}
</li>`;
}

export function renderAlbumPage(options: AlbumPageOptions): string {
  const { album, cover, featured, photos, permissions } = options;
  const coverBlock = cover
    ? `<button class="cover-photo" type="button" data-action="open-lightbox" data-full="${escapeHtml(cover.fullUrl)}" data-thumb="${escapeHtml(cover.thumbUrl)}" data-width="${cover.width}" data-height="${cover.height}" data-caption="${escapeHtml(cover.originalName ?? '')}" aria-label="查看封面大图">
        <img src="${escapeHtml(cover.thumbUrl)}" alt="${escapeHtml(album.name)} 的封面" width="600" height="600" fetchpriority="high">
        ${cover.isHdr ? '<span class="badge hdr">HDR</span>' : ''}
      </button>`
    : `<div class="cover-photo cover-empty"><span>还没有封面照片</span></div>`;
  const featuredBlock =
    featured.length > 0
      ? `<section class="album-section" aria-labelledby="featured-title">
  <h2 id="featured-title">精选</h2>
  <ul class="photo-grid">${featured.map((photo, index) => photoCard(photo, index)).join('')}</ul>
</section>`
      : '';
  const allBlock =
    photos.length > 0
      ? `<section class="album-section" aria-labelledby="all-title">
  <div class="section-heading"><h2 id="all-title">全部照片</h2><span class="muted">${album.photoCount} 张</span></div>
  <ul class="photo-grid" id="photo-grid">${photos.map((photo, index) => photoCard(photo, index)).join('')}</ul>
  ${options.nextCursor ? `<div class="load-more"><button class="button" type="button" data-action="load-more-photos" data-cursor="${escapeHtml(options.nextCursor)}">加载更多照片</button></div>` : ''}
</section>`
      : `<div class="empty-state"><h2>相册还是空的</h2><p>${permissions.canUpload ? '上传照片后，它们会出现在这里。' : '等上传者添加照片。'}</p>${permissions.canUpload ? `<a class="button primary" href="/upload?album=${album.id}">上传照片</a>` : ''}</div>`;
  const adminBar = permissions.canManageAlbum
    ? `<div class="album-admin">
  <button class="button small" type="button" data-action="toggle-album-visibility" data-visibility="${album.visibility === 'public' ? 'private' : 'public'}">${album.visibility === 'public' ? '设为私密相册' : '设为公开相册'}</button>
  <button class="button small danger" type="button" data-action="delete-album">删除相册</button>
</div>`
    : '';
  const body = `<article class="album-page" data-album-id="${album.id}" data-album-dir="${escapeHtml(album.dir)}" data-album-visibility="${album.visibility}">
  <header class="album-header">
    <div>
      <p class="breadcrumb"><a href="/">相册</a> / <span>${escapeHtml(album.name)}</span></p>
      <h1>${escapeHtml(album.name)} ${album.visibility === 'private' ? '<span class="badge private">私密</span>' : ''}</h1>
      <p class="muted">${album.photoCount} 张照片 · 创建于 ${new Date(album.createdAt).toLocaleDateString('zh-CN')}</p>
    </div>
    <div class="album-header-actions">
      ${permissions.canUpload ? `<a class="button primary" href="/upload?album=${album.id}">上传照片</a>` : ''}
      ${adminBar}
    </div>
  </header>
  <section class="cover-section" aria-label="相册封面">${coverBlock}</section>
  ${featuredBlock}
  <hr class="soft-divider">
  ${allBlock}
</article>`;
  return renderLayout({
    title: `${album.name} · Kig Photo Space`,
    body,
    role: options.role,
    authenticated: options.authenticated,
    active: 'home',
    assets: options.manifest.entry('main.ts'),
    bodyClass: 'album-body',
  });
}
