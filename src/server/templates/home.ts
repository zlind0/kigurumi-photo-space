import type { AlbumDTO, PersonDTO, Role } from '../../shared/types.js';
import { escapeHtml } from '../http/errors.js';
import { renderLayout, type AssetManifest } from './layout.js';

export interface HomePageOptions {
  albums: AlbumDTO[];
  nextCursor: string | null;
  people: PersonDTO[];
  role: Role;
  authenticated: boolean;
  manifest: AssetManifest;
}

function personButton(person: PersonDTO): string {
  return `<li class="person-item">
  <button class="person-button is-selected" type="button" data-action="filter-person" data-person-id="${person.id}" data-accent="${escapeHtml(person.accent)}" aria-pressed="true" title="${escapeHtml(person.name)}">
    <span class="person-avatar" style="--person-accent:${escapeHtml(person.accent)}">
      <img src="${escapeHtml(person.avatarUrl)}" alt="${escapeHtml(person.name)}" width="200" height="200" loading="lazy" decoding="async">
    </span>
    <span class="person-name">${escapeHtml(person.name)}</span>
  </button>
</li>`;
}

/** 从所有人物里均匀挑出 6 个色相，顺时针围成一个圈。 */
function selectAllDots(people: PersonDTO[]): string {
  const radius = 28;
  return Array.from({ length: 6 }, (_, index) => {
    const person = people[Math.floor((index * people.length) / 6)] ?? people[index % people.length]!;
    const angle = ((index * 60 - 90) * Math.PI) / 180;
    const x = 50 + radius * Math.cos(angle);
    const y = 50 + radius * Math.sin(angle);
    return `<span class="select-all-dot" style="--dot-color:${escapeHtml(person.accent)};left:${x.toFixed(2)}%;top:${y.toFixed(2)}%"></span>`;
  }).join('');
}

function peopleStrip(people: PersonDTO[]): string {
  if (people.length === 0) return '';
  const selectAll = `<li class="person-item">
  <button class="person-button select-all-button is-selected" type="button" data-action="select-all-people" aria-pressed="true" aria-label="全选人物" title="显示所有人物">
    <span class="select-all-dots" aria-hidden="true">${selectAllDots(people)}</span>
    <span class="person-name">全部</span>
  </button>
</li>`;
  return `<section class="people-strip" aria-label="按人物筛选相册">
  <ul class="people-grid" id="people-grid" style="--people-count:${people.length + 1}">${selectAll}${people.map(personButton).join('')}</ul>
</section>`;
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
  const personIds = album.people.map((person) => person.id).join(',');
  return `<li class="album-item" data-people="${personIds}">
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
  const body = `${peopleStrip(options.people)}
${empty}
<ul class="album-grid" id="album-grid">${cards}${newCard}</ul>
<div class="empty-state people-empty" id="people-empty" hidden>
  <h2>没有符合条件的相册</h2>
  <p>换一个或减少选中的人物试试。</p>
</div>
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
    hideHomeLink: true,
    assets: options.manifest.entry('main.ts'),
  });
}
