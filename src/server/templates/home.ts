import type { AlbumDTO, Role } from '../../shared/types.js';
import { escapeHtml } from '../http/errors.js';
import { renderLayout, type AssetManifest } from './layout.js';

export interface HomePageOptions {
  albums: AlbumDTO[];
  nextCursor: string | null;
  role: Role;
  authenticated: boolean;
  manifest: AssetManifest;
}

function albumCard(album: AlbumDTO, index: number, role: Role): string {
  const cover = album.cover;
  const image = cover
    ? `<img src="${escapeHtml(cover.thumbUrl)}" alt="${escapeHtml(album.name)} 的封面" width="600" height="600" ${index === 0 ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}>`
    : `<span class="album-placeholder" aria-hidden="true">暂无照片</span>`;
  const backLayer = cover
    ? `<span class="album-print-inner" style="background-image:url('${escapeHtml(cover.thumbUrl)}')"></span>`
    : '<span class="album-print-inner"></span>';
  const privateBadge =
    album.visibility === 'private' && role !== 'public'
      ? '<span class="badge private">私密</span>'
      : '';
  return `<li class="album-item">
  <a class="album-card" href="/a/${encodeURIComponent(album.dir)}" data-album-id="${album.id}">
    <span class="album-stack">
      <span class="album-print album-print-back" aria-hidden="true">${backLayer}</span>
      <span class="album-print album-print-mid" aria-hidden="true">${backLayer}</span>
      <span class="album-print album-print-front"><span class="album-print-inner">${image}</span></span>
    </span>
    <span class="album-meta">
      <span class="album-text">
        <span class="album-name">${escapeHtml(album.name)}</span>
        <span class="album-count">${album.photoCount} 张照片 ${privateBadge}</span>
      </span>
      <span class="album-chevron" aria-hidden="true">›</span>
    </span>
  </a>
</li>`;
}

export function renderHomePage(options: HomePageOptions): string {
  const canCreate = options.role === 'uploader' || options.role === 'admin';
  const cards = options.albums.map((album, index) => albumCard(album, index, options.role)).join('');
  const newCard = canCreate
    ? `<li class="album-item">
  <button class="album-card album-new" type="button" data-action="new-album">
    <span class="album-stack">
      <span class="album-print album-print-front"><span class="plus" aria-hidden="true">+</span></span>
    </span>
    <span class="album-meta">
      <span class="album-text"><span class="album-name">新建相册</span><span class="album-count">上传一组照片</span></span>
      <span class="album-chevron" aria-hidden="true">›</span>
    </span>
  </button>
</li>`
    : '';
  const empty =
    options.albums.length === 0
      ? `<div class="empty-state">
  <h2>还没有相册</h2>
  <p>${canCreate ? '创建第一个相册，然后上传照片。' : '等上传者创建相册后，这里会出现照片。'}</p>
  ${canCreate ? '<button class="button primary" type="button" data-action="new-album">新建第一个相册</button>' : ''}
</div>`
      : '';
  const body = `<section class="page-heading">
  <div>
    <h1>相册</h1>
    <p class="muted">按创建时间倒序排列。公开照片无需登录即可浏览。</p>
  </div>
</section>
${empty}
<ul class="album-grid" id="album-grid">${cards}${newCard}</ul>
${options.nextCursor ? `<div class="load-more"><button class="button" type="button" data-action="load-more-albums" data-cursor="${escapeHtml(options.nextCursor)}">加载更多相册</button></div>` : ''}
<dialog id="new-album-dialog" class="dialog" aria-labelledby="new-album-title">
  <form id="new-album-form" method="dialog" novalidate>
    <h2 id="new-album-title">新建相册</h2>
    <label class="field">
      <span>相册名</span>
      <input id="new-album-name" name="name" type="text" maxlength="80" required autofocus placeholder="例如：2026 春">
    </label>
    <p id="new-album-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-new-album">取消</button>
      <button type="submit" class="button primary">创建</button>
    </div>
  </form>
</dialog>`;
  return renderLayout({
    title: '相册 · Kig Photo Space',
    body,
    role: options.role,
    authenticated: options.authenticated,
    active: 'home',
    assets: options.manifest.entry('main.ts'),
  });
}
