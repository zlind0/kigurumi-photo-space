import { ICON_LOCK, ICON_STAR, ICON_TRASH } from '../../shared/icons.js';
import type { AlbumDTO, PermissionsDTO, PersonDTO, PhotoDTO, Role } from '../../shared/types.js';
import { escapeHtml } from '../http/errors.js';
import { renderLayout, type AssetManifest } from './layout.js';

export interface AlbumPageOptions {
  album: AlbumDTO;
  photos: PhotoDTO[];
  nextCursor: string | null;
  allPeople: PersonDTO[];
  permissions: PermissionsDTO;
  role: Role;
  authenticated: boolean;
  manifest: AssetManifest;
}

function albumPeople(people: PersonDTO[]): string {
  if (people.length === 0) return '';
  return `<div class="album-people" aria-label="相册中的人物">
    ${people
      .map(
        (person) =>
          `<span class="album-person" style="--person-accent:${escapeHtml(person.accent)}" title="${escapeHtml(person.name)}"><img src="${escapeHtml(person.avatarUrl)}" alt="${escapeHtml(person.name)}" width="200" height="200" loading="lazy" decoding="async"></span>`,
      )
      .join('')}
  </div>`;
}

function peopleEditor(album: AlbumDTO, allPeople: PersonDTO[]): string {
  if (allPeople.length === 0) {
    return `<dialog id="album-people-dialog" class="dialog" aria-labelledby="album-people-title">
  <form id="album-people-form" method="dialog">
    <h2 id="album-people-title">编辑相册人物</h2>
    <p class="muted">还没有人物。请先到管理台添加人物。</p>
    <div class="dialog-actions"><button type="button" class="button ghost" data-action="close-album-people">关闭</button></div>
  </form>
</dialog>`;
  }
  const selected = new Set(album.people.map((person) => person.id));
  return `<dialog id="album-people-dialog" class="dialog" aria-labelledby="album-people-title">
  <form id="album-people-form" method="dialog" novalidate>
    <h2 id="album-people-title">编辑相册人物</h2>
    <p class="muted">勾选出现在这个相册中的人物。</p>
    <ul class="people-picker">
      ${allPeople
        .map(
          (person) => `<li>
        <label class="people-picker-item">
          <input type="checkbox" name="person" value="${person.id}" ${selected.has(person.id) ? 'checked' : ''}>
          <span class="album-person" style="--person-accent:${escapeHtml(person.accent)}"><img src="${escapeHtml(person.avatarUrl)}" alt="" width="200" height="200" loading="lazy" decoding="async"></span>
          <span>${escapeHtml(person.name)}</span>
        </label>
      </li>`,
        )
        .join('')}
    </ul>
    <p id="album-people-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-album-people">取消</button>
      <button type="submit" class="button primary">保存</button>
    </div>
  </form>
</dialog>`;
}

function photoActions(photo: PhotoDTO): string {
  const actions: string[] = [];
  if (photo.canSetTier) {
    if (photo.tier !== 'cover') {
      actions.push(`<button type="button" class="mini-button" data-action="set-tier" data-tier="cover">设为封面</button>`);
    }
    const featured = photo.tier === 'featured';
    actions.push(
      `<button type="button" class="mini-button icon-button${featured ? ' is-on' : ''}" data-action="set-tier" data-tier="${featured ? 'other' : 'featured'}" aria-pressed="${featured}" aria-label="${featured ? '取消精选' : '设为精选'}" title="${featured ? '取消精选' : '设为精选'}">${ICON_STAR}</button>`,
    );
    if (photo.tier === 'cover') {
      actions.push(`<button type="button" class="mini-button" data-action="set-tier" data-tier="other">其他</button>`);
    }
  }
  if (photo.canSetVisibility) {
    const isPrivate = photo.visibility === 'private';
    actions.push(
      `<button type="button" class="mini-button icon-button${isPrivate ? ' is-on' : ''}" data-action="set-visibility" data-visibility="${isPrivate ? 'public' : 'private'}" aria-pressed="${isPrivate}" aria-label="${isPrivate ? '设为公开' : '设为私密'}" title="${isPrivate ? '设为公开' : '设为私密'}">${ICON_LOCK}</button>`,
    );
  }
  if (photo.canDelete) {
    actions.push(
      `<button type="button" class="mini-button danger icon-button" data-action="delete-photo" aria-label="删除照片" title="删除照片">${ICON_TRASH}</button>`,
    );
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
  <button class="photo-card" type="button" data-action="open-lightbox" data-photo-id="${photo.id}" data-full="${escapeHtml(photo.fullUrl)}" data-thumb="${escapeHtml(photo.thumbUrl)}" data-width="${photo.width}" data-height="${photo.height}" data-caption="${escapeHtml(photo.originalName ?? '')}" aria-label="查看照片 ${escapeHtml(photo.originalName ?? String(photo.id))}">
    <img src="${escapeHtml(photo.thumbUrl)}" alt="${escapeHtml(photo.originalName ?? '照片')}" width="600" height="600" ${loading}>
    ${badges.length ? `<span class="photo-badges">${badges.join('')}</span>` : ''}
  </button>
  ${photoActions(photo)}
</li>`;
}

export function renderAlbumPage(options: AlbumPageOptions): string {
  const { album, photos, permissions } = options;
  const photoBody =
    photos.length > 0
      ? `<ul class="photo-grid" id="photo-grid">${photos.map((photo, index) => photoCard(photo, index)).join('')}</ul>
  ${options.nextCursor ? `<div class="load-more"><button class="button" type="button" data-action="load-more-photos" data-cursor="${escapeHtml(options.nextCursor)}">加载更多照片</button></div>` : ''}`
      : `<div class="empty-state"><h2>相册还是空的</h2><p>${permissions.canUpload ? '上传照片后，它们会出现在这里。' : '等上传者添加照片。'}</p></div>`;
  const sectionActions: string[] = [];
  if (permissions.canUpload) {
    sectionActions.push(`<a class="button primary" href="/upload?album=${album.id}">上传照片</a>`);
  }
  if (permissions.canManageAlbum) {
    sectionActions.push(
      `<button class="button small" type="button" data-action="edit-album-people">编辑人物</button>`,
      `<button class="button small" type="button" data-action="toggle-album-visibility" data-visibility="${album.visibility === 'public' ? 'private' : 'public'}">${album.visibility === 'public' ? '设为私密相册' : '设为公开相册'}</button>`,
      `<button class="button small danger" type="button" data-action="delete-album">删除相册</button>`,
    );
  }
  const actionsBlock = sectionActions.length
    ? `<div class="section-heading-actions">${sectionActions.join('')}</div>`
    : '';
  const body = `<article class="album-page" data-album-id="${album.id}" data-album-dir="${escapeHtml(album.dir)}" data-album-visibility="${album.visibility}">
  <header class="album-header">
    <div class="album-heading">
      <h1>${escapeHtml(album.name)} ${album.visibility === 'private' ? '<span class="badge private">私密</span>' : ''}</h1>
      <p class="album-stats">${album.photoCount} 张照片 · 创建于 ${new Date(album.createdAt).toLocaleDateString('zh-CN')}</p>
    </div>
    ${albumPeople(album.people)}
  </header>
  <section class="album-section" aria-labelledby="all-title">
    <div class="section-heading">
      <div class="section-heading-title">
        <h2 id="all-title">全部照片</h2>
        <span class="muted">${album.photoCount} 张</span>
      </div>
      ${actionsBlock}
    </div>
    ${photoBody}
  </section>
</article>
${permissions.canManageAlbum ? peopleEditor(album, options.allPeople) : ''}`;
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
