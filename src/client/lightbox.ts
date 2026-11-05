import { toast } from './api.js';
import { closeDialog, setupBackdropClose } from './ui.js';

interface LightboxItem {
  full: string;
  thumb: string;
  caption: string;
  width: number;
  height: number;
}

export function setupLightbox(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#lightbox');
  const image = document.querySelector<HTMLImageElement>('#lightbox-image');
  const caption = document.querySelector<HTMLElement>('#lightbox-caption');
  if (!dialog || !image || !caption) return;
  setupBackdropClose(dialog);

  let items: LightboxItem[] = [];
  let index = 0;

  const current = (): LightboxItem | null => items[index] ?? null;

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
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建画布');
        context.drawImage(image, 0, 0);
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

  const collect = (): LightboxItem[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-action="open-lightbox"]')).map((node) => ({
      full: node.dataset.full ?? '',
      thumb: node.dataset.thumb ?? '',
      caption: node.dataset.caption ?? '',
      width: Number(node.dataset.width ?? 0),
      height: Number(node.dataset.height ?? 0),
    }));

  const show = (nextIndex: number) => {
    if (items.length === 0) return;
    index = (nextIndex + items.length) % items.length;
    const item = items[index]!;
    image.alt = item.caption || '照片';
    image.src = item.full;
    image.width = item.width;
    image.height = item.height;
    caption.textContent = item.caption ? `${item.caption} · ${index + 1} / ${items.length}` : `${index + 1} / ${items.length}`;
  };

  const open = (node: HTMLElement) => {
    items = collect();
    const full = node.dataset.full ?? '';
    const found = items.findIndex((item) => item.full === full);
    index = found >= 0 ? found : 0;
    show(index);
    if (!dialog.open) dialog.showModal();
  };

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const actionNode = target?.closest<HTMLElement>('[data-action]');
    const action = actionNode?.dataset.action;
    if (action === 'open-lightbox' && actionNode) {
      event.preventDefault();
      open(actionNode);
    } else if (action === 'lightbox-close') {
      closeDialog(dialog);
    } else if (action === 'lightbox-prev') {
      show(index - 1);
    } else if (action === 'lightbox-next') {
      show(index + 1);
    } else if (action === 'download-avif') {
      event.preventDefault();
      void downloadAvif();
    } else if (action === 'download-jpeg') {
      event.preventDefault();
      void downloadJpeg();
    }
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

  image.addEventListener('error', () => {
    caption.textContent = '图片加载失败，请重试';
  });
}
