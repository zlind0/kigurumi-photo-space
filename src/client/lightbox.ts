import type { PhotoInfoDTO } from '../shared/types.js';
import { api, formatBytes, toast } from './api.js';
import { closeDialog, setupBackdropClose } from './ui.js';

interface LightboxItem {
  id: number;
  full: string;
  preview: string;
  thumb: string;
  caption: string;
  width: number;
  height: number;
}

const EXIF_LABELS: Record<string, string> = {
  Make: '相机品牌',
  Model: '相机型号',
  LensModel: '镜头',
  DateTimeOriginal: '拍摄时间',
  ExposureTime: '曝光时间',
  FNumber: '光圈',
  ISO: 'ISO',
  FocalLength: '焦距',
  GPSLatitude: '纬度',
  GPSLongitude: '经度',
  Orientation: '方向',
};

function formatDate(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatExifValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (key === 'ExposureTime' && typeof value === 'number') {
    if (value > 0 && value < 1) return `1/${Math.round(1 / value)} 秒`;
    return `${value} 秒`;
  }
  if (key === 'FNumber' && typeof value === 'number') return `f/${value}`;
  if (key === 'FocalLength' && typeof value === 'number') return `${value} mm`;
  if (key === 'ISO' && typeof value === 'number') return String(value);
  if (key === 'DateTimeOriginal') return formatDate(String(value));
  if (key === 'GPSLatitude' || key === 'GPSLongitude') {
    return typeof value === 'number' ? value.toFixed(6) : String(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function infoRow(label: string, value: string): [HTMLElement, HTMLElement] {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  return [term, detail];
}

function renderInfo(container: HTMLElement, info: PhotoInfoDTO): void {
  container.replaceChildren();
  const list = document.createElement('dl');
  list.className = 'info-list';

  const rows: Array<[string, string]> = [
    ['文件名', info.originalName || '未命名'],
    ['尺寸', `${info.width} × ${info.height}`],
    ['文件大小', formatBytes(info.sizeBytes)],
    ['上传时间', formatDate(info.createdAt)],
    ['格式', `${info.mime.replace('image/', '').toUpperCase()} · ${info.bitDepth} bit${info.isHdr ? ' · HDR' : ''}${info.hasAlpha ? ' · 透明' : ''}`],
  ];

  if (info.exif) {
    for (const [key, value] of Object.entries(info.exif)) {
      const formatted = formatExifValue(key, value);
      if (!formatted) continue;
      rows.push([EXIF_LABELS[key] ?? key, formatted]);
    }
  }

  for (const [label, value] of rows) {
    const [term, detail] = infoRow(label, value);
    list.append(term, detail);
  }
  container.append(list);

  if (!info.exif || Object.keys(info.exif).length === 0) {
    const note = document.createElement('p');
    note.className = 'muted info-note';
    note.textContent = info.exifPreserved ? '这张照片没有可读取的 EXIF 信息。' : '上传时未保留 EXIF 信息。';
    container.append(note);
  }
}

export function setupLightbox(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#lightbox');
  const image = document.querySelector<HTMLImageElement>('#lightbox-image');
  const placeholder = document.querySelector<HTMLElement>('.lightbox-placeholder');
  const infoWrap = document.querySelector<HTMLElement>('.lightbox-info');
  const infoButton = document.querySelector<HTMLButtonElement>('[data-action="lightbox-info"]');
  const infoBody = document.querySelector<HTMLElement>('#lightbox-info-body');
  const downloadWrap = document.querySelector<HTMLElement>('.lightbox-download');
  const downloadButton = document.querySelector<HTMLButtonElement>('[data-action="lightbox-download"]');
  if (!dialog || !image) return;
  setupBackdropClose(dialog);

  let items: LightboxItem[] = [];
  let index = 0;
  let loadToken = 0;
  let glowTimer: number | undefined;
  const infoCache = new Map<number, PhotoInfoDTO>();
  const preloaded = new Set<string>();

  const current = (): LightboxItem | null => items[index] ?? null;

  // 当前照片显示后，用低优先级提前把下一张预览图放进浏览器缓存。
  // 这样用户切到下一张时通常可以直接命中缓存，弱网下也不会和当前照片抢带宽。
  const preload = (item: LightboxItem | undefined): void => {
    const source = item?.preview || item?.full;
    if (!source || preloaded.has(source)) return;
    preloaded.add(source);
    const preloadImage = new Image();
    preloadImage.decoding = 'async';
    preloadImage.fetchPriority = 'low';
    preloadImage.onerror = () => preloaded.delete(source);
    preloadImage.src = source;
  };

  const beginLoading = (): void => {
    window.clearTimeout(glowTimer);
    dialog.classList.add('is-loading');
    dialog.classList.remove('is-slow');
    dialog.setAttribute('aria-busy', 'true');
    glowTimer = window.setTimeout(() => {
      if (dialog.classList.contains('is-loading')) dialog.classList.add('is-slow');
    }, 300);
  };

  const endLoading = (): void => {
    window.clearTimeout(glowTimer);
    glowTimer = undefined;
    dialog.classList.remove('is-loading', 'is-slow');
    dialog.removeAttribute('aria-busy');
  };

  const filename = (extension: string): string => {
    const item = current();
    const base = (item?.caption || `photo-${index + 1}`).replace(/\.[^.]+$/, '');
    return `${base}.${extension}`;
  };

  const saveBlob = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const closeDownloadMenu = (): void => {
    downloadWrap?.classList.remove('is-open');
    downloadButton?.setAttribute('aria-expanded', 'false');
  };

  const downloadAvif = async (): Promise<void> => {
    const item = current();
    if (!item) return;
    try {
      const response = await fetch(item.full, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`下载失败 (${response.status})`);
      saveBlob(await response.blob(), filename('avif'));
    } catch (error) {
      toast(error instanceof Error ? error.message : '下载失败', 'error');
    }
  };

  const downloadJpeg = async (): Promise<void> => {
    const item = current();
    if (!item) return;
    try {
      const response = await fetch(item.full, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`下载失败 (${response.status})`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const source = new Image();
        source.src = objectUrl;
        await source.decode();
        const canvas = document.createElement('canvas');
        canvas.width = source.naturalWidth;
        canvas.height = source.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建画布');
        context.drawImage(source, 0, 0);
        const jpeg = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.9),
        );
        if (!jpeg) throw new Error('JPEG 编码失败');
        saveBlob(jpeg, filename('jpg'));
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'JPEG 转换失败', 'error');
    }
  };

  const loadInfo = async (): Promise<void> => {
    const item = current();
    if (!item || !infoBody) return;
    const cached = infoCache.get(item.id);
    if (cached) {
      renderInfo(infoBody, cached);
      return;
    }
    infoBody.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.textContent = '正在读取照片信息…';
    infoBody.append(loading);
    try {
      const info = await api<PhotoInfoDTO>(`/api/photos/${item.id}/info`);
      infoCache.set(item.id, info);
      if (current()?.id === item.id) renderInfo(infoBody, info);
    } catch (error) {
      if (current()?.id !== item.id) return;
      infoBody.replaceChildren();
      const message = document.createElement('p');
      message.className = 'form-error';
      message.textContent = error instanceof Error ? error.message : '读取照片信息失败';
      infoBody.append(message);
    }
  };

  const collect = (): LightboxItem[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-action="open-lightbox"]')).map((node) => ({
      id: Number(node.dataset.photoId ?? 0),
      full: node.dataset.full ?? '',
      preview: node.dataset.preview ?? '',
      thumb: node.dataset.thumb ?? '',
      caption: node.dataset.caption ?? '',
      width: Number(node.dataset.width ?? 0),
      height: Number(node.dataset.height ?? 0),
    }));

  const show = (nextIndex: number) => {
    if (items.length === 0) return;
    index = (nextIndex + items.length) % items.length;
    const item = items[index]!;
    const token = ++loadToken;
    image.alt = item.caption || '照片';
    image.width = item.width;
    image.height = item.height;
    // 先淡出上一张，避免新图加载期间继续显示旧图（例如相册封面）。
    image.classList.remove('is-loaded');
    if (placeholder) {
      placeholder.style.backgroundImage = item.thumb ? `url(${JSON.stringify(item.thumb)})` : 'none';
      placeholder.classList.toggle('is-visible', Boolean(item.thumb));
    }
    beginLoading();
    const source = item.preview || item.full;
    image.src = source;
    const decode = (): Promise<void> => image.decode();
    decode()
      .catch(() => {
        if (source === item.full) throw new Error('图片加载失败');
        // 预览图缺失时回退到原图，保证旧照片仍然可以查看。
        image.src = item.full;
        return decode();
      })
      .then(
        () => {
          if (token !== loadToken) return;
          endLoading();
          image.classList.add('is-loaded');
          preload(items[(index + 1) % items.length]);
        },
        () => {
          if (token !== loadToken) return;
          endLoading();
          toast('图片加载失败，请重试', 'error');
          preload(items[(index + 1) % items.length]);
        },
      );
    if (infoWrap?.matches(':hover, :focus-within, .is-open')) void loadInfo();
  };

  const open = (node: HTMLElement) => {
    items = collect();
    const full = node.dataset.full ?? '';
    const found = items.findIndex((item) => item.full === full);
    index = found >= 0 ? found : 0;
    if (!dialog.open) {
      // 打开前先清掉上一张清晰图，并把模糊底图换成当前照片。
      image.classList.remove('is-loaded');
      const item = items[index];
      if (placeholder && item) {
        placeholder.style.backgroundImage = item.thumb ? `url(${JSON.stringify(item.thumb)})` : 'none';
        placeholder.classList.toggle('is-visible', Boolean(item.thumb));
      }
      dialog.showModal();
      // showModal 默认聚焦第一个可聚焦元素（信息按钮），会让信息弹窗一打开就展开。
      dialog.focus();
    }
    show(index);
  };

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const actionNode = target?.closest<HTMLElement>('[data-action]');
    const action = actionNode?.dataset.action;
    if (action !== 'lightbox-download' && !target?.closest('.lightbox-download')) {
      closeDownloadMenu();
    }
    if (action === 'open-lightbox' && actionNode) {
      event.preventDefault();
      open(actionNode);
    } else if (action === 'lightbox-close') {
      closeDialog(dialog);
    } else if (action === 'lightbox-prev') {
      show(index - 1);
    } else if (action === 'lightbox-next') {
      show(index + 1);
    } else if (action === 'lightbox-info') {
      event.preventDefault();
      infoWrap?.classList.toggle('is-open');
      infoButton?.setAttribute('aria-expanded', infoWrap?.classList.contains('is-open') ? 'true' : 'false');
      void loadInfo();
    } else if (action === 'lightbox-download') {
      event.preventDefault();
      const isOpen = downloadWrap?.classList.toggle('is-open') ?? false;
      downloadButton?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    } else if (action === 'download-avif') {
      event.preventDefault();
      closeDownloadMenu();
      void downloadAvif();
    } else if (action === 'download-jpeg') {
      event.preventDefault();
      closeDownloadMenu();
      void downloadJpeg();
    }
  });

  infoWrap?.addEventListener('pointerenter', () => {
    infoButton?.setAttribute('aria-expanded', 'true');
    void loadInfo();
  });
  infoWrap?.addEventListener('pointerleave', () => {
    infoWrap.classList.remove('is-open');
    infoButton?.setAttribute('aria-expanded', 'false');
  });
  infoWrap?.addEventListener('focusin', () => {
    infoButton?.setAttribute('aria-expanded', 'true');
    void loadInfo();
  });
  infoWrap?.addEventListener('focusout', (event) => {
    if (infoWrap.contains(event.relatedTarget as Node | null)) return;
    infoWrap.classList.remove('is-open');
    infoButton?.setAttribute('aria-expanded', 'false');
  });

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      show(index + 1);
    }
  });

  dialog.addEventListener('close', () => {
    closeDownloadMenu();
    infoWrap?.classList.remove('is-open');
    infoButton?.setAttribute('aria-expanded', 'false');
    loadToken += 1;
    endLoading();
    image.classList.remove('is-loaded');
  });
}
