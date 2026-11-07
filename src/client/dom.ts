import { ICON_LOCK, ICON_STAR, ICON_TRASH } from '../shared/icons.js';
import type { AlbumDTO, PhotoDTO } from '../shared/types.js';

type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'className') {
      node.className = String(value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function badge(text: string, className: string): HTMLSpanElement {
  return el('span', { className: `badge ${className}`, text });
}

function iconButton(
  className: string,
  attrs: Attrs,
  icon: string,
): HTMLButtonElement {
  const button = el('button', { className, type: 'button', ...attrs });
  button.insertAdjacentHTML('beforeend', icon);
  return button;
}

export function photoCard(photo: PhotoDTO): HTMLLIElement {
  const badges: HTMLSpanElement[] = [];
  if (photo.isHdr) badges.push(badge('HDR', 'hdr'));
  if (photo.visibility === 'private') badges.push(badge('私密', 'private'));
  if (photo.tier === 'cover') badges.push(badge('封面', 'cover'));

  const img = el('img', {
    src: photo.thumbUrl,
    alt: photo.originalName ?? '照片',
    width: 400,
    height: 400,
    loading: 'lazy',
    decoding: 'async',
  });
  const button = el(
    'button',
    {
      className: 'photo-card',
      type: 'button',
      'data-action': 'open-lightbox',
      'data-photo-id': photo.id,
      'data-full': photo.fullUrl,
      'data-preview': photo.previewUrl,
      'data-thumb': photo.thumbUrl,
      'data-width': photo.width,
      'data-height': photo.height,
      'data-caption': photo.originalName ?? '',
      'aria-label': `查看照片 ${photo.originalName ?? photo.id}`,
    },
    [img],
  );
  if (badges.length) {
    button.append(el('span', { className: 'photo-badges' }, badges));
  }

  const actions: HTMLButtonElement[] = [];
  if (photo.canSetTier) {
    if (photo.tier !== 'cover') {
      actions.push(el('button', { className: 'mini-button', type: 'button', 'data-action': 'set-tier', 'data-tier': 'cover', text: '设为封面' }));
    }
    const featured = photo.tier === 'featured';
    const label = featured ? '取消精选' : '设为精选';
    actions.push(
      iconButton(`mini-button icon-button${featured ? ' is-on' : ''}`, {
        'data-action': 'set-tier',
        'data-tier': featured ? 'other' : 'featured',
        'aria-pressed': featured ? 'true' : 'false',
        'aria-label': label,
        title: label,
      }, ICON_STAR),
    );
    if (photo.tier === 'cover') {
      actions.push(el('button', { className: 'mini-button', type: 'button', 'data-action': 'set-tier', 'data-tier': 'other', text: '其他' }));
    }
  }
  if (photo.canSetVisibility) {
    const isPrivate = photo.visibility === 'private';
    const label = isPrivate ? '设为公开' : '设为私密';
    actions.push(
      iconButton(`mini-button icon-button${isPrivate ? ' is-on' : ''}`, {
        'data-action': 'set-visibility',
        'data-visibility': isPrivate ? 'public' : 'private',
        'aria-pressed': isPrivate ? 'true' : 'false',
        'aria-label': label,
        title: label,
      }, ICON_LOCK),
    );
  }
  if (photo.canDelete) {
    actions.push(
      iconButton('mini-button danger icon-button', {
        'data-action': 'delete-photo',
        'aria-label': '删除照片',
        title: '删除照片',
      }, ICON_TRASH),
    );
  }

  const item = el(
    'li',
    {
      className: 'photo-item',
      'data-photo-id': photo.id,
      'data-tier': photo.tier,
      'data-visibility': photo.visibility,
      'data-can-delete': photo.canDelete ? '1' : '0',
      'data-can-set-tier': photo.canSetTier ? '1' : '0',
      'data-can-set-visibility': photo.canSetVisibility ? '1' : '0',
    },
    [button],
  );
  if (actions.length) item.append(el('div', { className: 'photo-actions' }, actions));
  return item;
}

export function albumCard(album: AlbumDTO, index: number): HTMLLIElement {
  const image = album.cover
    ? el('img', {
        src: album.cover.thumbUrl,
        alt: `${album.name} 的封面`,
        width: 400,
        height: 400,
        ...(index === 0
          ? { fetchpriority: 'high' }
          : { loading: 'lazy', decoding: 'async' }),
      })
    : el('span', { className: 'album-placeholder', text: '暂无照片' });
  const backLayer = (): HTMLSpanElement => {
    const inner = el('span', { className: 'album-print-inner' });
    if (album.cover) inner.style.backgroundImage = `url("${album.cover.thumbUrl}")`;
    return inner;
  };
  const meta = el('span', { className: 'album-meta' }, [
    el('span', { className: 'album-text' }, [
      el('span', { className: 'album-name', text: album.name }),
      el('span', { className: 'album-count' }, [
        `${album.photoCount} 张照片 `,
        ...(album.visibility === 'private' ? [badge('私密', 'private')] : []),
      ]),
    ]),
    el('span', { className: 'album-chevron', 'aria-hidden': 'true', text: '›' }),
  ]);
  const link = el(
    'a',
    { className: 'album-card', href: `/a/${encodeURIComponent(album.dir)}`, 'data-album-id': album.id },
    [
      el('span', { className: 'album-stack' }, [
        el('span', { className: 'album-print album-print-back', 'aria-hidden': 'true' }, [backLayer()]),
        el('span', { className: 'album-print album-print-mid', 'aria-hidden': 'true' }, [backLayer()]),
        el('span', { className: 'album-print album-print-front' }, [
          el('span', { className: 'album-print-inner' }, [image]),
        ]),
      ]),
      meta,
    ],
  );
  return el('li', {
    className: 'album-item',
    'data-people': album.people.map((person) => person.id).join(','),
  }, [link]);
}
