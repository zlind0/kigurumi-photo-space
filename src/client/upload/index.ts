import '../styles/app.css';
import type { AlbumDTO, PhotoDTO, UploadResponse } from '../../shared/types.js';
import { ApiError, toast } from '../api.js';
import { setupCommon } from '../common.js';
import { el, photoCard } from '../dom.js';
import type { ProcessOptions, ResultMessage, WorkerMessage } from './types.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|avif)$/i;

interface QueueItem {
  id: number;
  file: File;
  status: 'queued' | 'processing' | 'uploading' | 'done' | 'error' | 'cancelled';
  stage: string;
  progress: number;
  result?: ResultMessage;
  error?: string;
  node: HTMLLIElement;
  thumb: HTMLImageElement;
  stageNode: HTMLElement;
  statusNode: HTMLElement;
  progressNode: HTMLProgressElement;
  cancelButton: HTMLButtonElement;
  retryButton: HTMLButtonElement;
}

function isImageFile(file: File): boolean {
  if (!IMAGE_EXT.test(file.name)) return false;
  if (file.name.startsWith('.')) return false;
  if (file.webkitRelativePath.includes('__MACOSX')) return false;
  return true;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function uploadPhoto(
  albumId: number,
  full: Blob,
  thumb: Blob,
  meta: unknown,
  onProgress: (fraction: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/albums/${albumId}/photos`);
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response as UploadResponse | { error?: { code?: string; message?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && 'photo' in body) {
        resolve(body as UploadResponse);
        return;
      }
      const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
      reject(new ApiError(xhr.status, error?.code ?? 'UPLOAD_FAILED', error?.message ?? `上传失败 (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    const form = new FormData();
    form.append('full', full, 'full.avif');
    form.append('thumb', thumb, 'thumb.avif');
    form.append('meta', JSON.stringify(meta));
    xhr.send(form);
  });
}

async function collectEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  while (true) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (entries.length === 0) break;
    for (const child of entries) await collectEntry(child, out);
  }
}

async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (entries.length === 0) return Array.from(dataTransfer.files);
  const files: File[] = [];
  for (const entry of entries) await collectEntry(entry, files);
  return files;
}

function setupUpload(): void {
  const app = document.querySelector<HTMLElement>('#upload-app');
  if (!app) return;
  const albumSelect = document.querySelector<HTMLSelectElement>('#album-select');
  const fileInput = document.querySelector<HTMLInputElement>('#file-input');
  const folderInput = document.querySelector<HTMLInputElement>('#folder-input');
  const dropZone = document.querySelector<HTMLElement>('#drop-zone');
  const queueList = document.querySelector<HTMLUListElement>('#upload-queue');
  const progressBox = document.querySelector<HTMLElement>('#upload-progress');
  const overall = document.querySelector<HTMLProgressElement>('#overall-progress');
  const progressLabel = document.querySelector<HTMLElement>('#progress-label');
  const progressCount = document.querySelector<HTMLElement>('#progress-count');
  const results = document.querySelector<HTMLElement>('#upload-results');
  const resultsGrid = document.querySelector<HTMLUListElement>('#upload-results-grid');
  if (!albumSelect || !fileInput || !folderInput || !dropZone || !queueList) return;

  const options: ProcessOptions = {
    maxDimension: 10000,
    maxPixels: 100_000_000,
    fullQuality: 60,
    thumbQuality: 50,
    speed: 8,
  };

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (value: ResultMessage) => void; reject: (error: Error) => void }>();
  const queue: QueueItem[] = [];
  let nextId = 1;
  let processing = false;
  let completed = 0;

  const albumId = (): number | null => {
    const value = Number(albumSelect.value);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };

  const updateOverall = () => {
    if (!overall || !progressCount || !progressLabel) return;
    const total = queue.length;
    const done = queue.filter((item) => item.status === 'done' || item.status === 'error' || item.status === 'cancelled').length;
    overall.value = total ? Math.round((done / total) * 100) : 0;
    progressCount.textContent = `${done} / ${total}`;
    progressLabel.textContent = processing ? '正在处理…' : done === total && total > 0 ? '全部完成' : '等待中';
  };

  const setStatus = (item: QueueItem, status: QueueItem['status'], text: string) => {
    item.status = status;
    item.statusNode.textContent = text;
    item.statusNode.className = `queue-status${status === 'error' ? ' error' : status === 'done' ? ' ok' : ''}`;
    item.cancelButton.hidden = status !== 'queued' && status !== 'processing';
    item.retryButton.hidden = status !== 'error';
    updateOverall();
  };

  const addResult = (photo: PhotoDTO) => {
    if (!results || !resultsGrid) return;
    results.hidden = false;
    resultsGrid.append(photoCard(photo));
  };

  const processItem = async (item: QueueItem): Promise<void> => {
    const id = albumId();
    if (!id) {
      setStatus(item, 'error', '未选择相册');
      return;
    }
    setStatus(item, 'processing', '处理中');
    item.stageNode.textContent = '准备中…';
    item.progressNode.value = 0;
    let result: ResultMessage;
    try {
      result = await new Promise<ResultMessage>((resolve, reject) => {
        pending.set(item.id, { resolve, reject });
        worker.postMessage({ id: item.id, file: item.file, options });
      });
    } catch (error) {
      setStatus(item, 'error', error instanceof Error ? error.message : '处理失败');
      item.stageNode.textContent = '失败';
      return;
    }
    if (item.status === 'cancelled') return;
    item.result = result;
    const fullBlob = new Blob([result.full], { type: 'image/avif' });
    const thumbBlob = new Blob([result.thumb], { type: 'image/avif' });
    const fullSize = fullBlob.size;
    item.thumb.src = URL.createObjectURL(thumbBlob);
    item.stageNode.textContent = result.warnings.length ? result.warnings.join('；') : '编码完成';
    setStatus(item, 'uploading', '上传中');
    item.progressNode.value = 0;
    try {
      const response = await uploadPhoto(id, fullBlob, thumbBlob, result.meta, (fraction) => {
        item.progressNode.value = Math.round(fraction * 100);
      });
      item.progressNode.value = 100;
      setStatus(item, 'done', response.deduped ? '已存在' : '已上传');
      item.stageNode.textContent = `${result.width}×${result.height} · ${result.bitDepth}-bit${result.isHdr ? ' HDR' : ''} · ${formatSize(fullSize)}`;
      addResult(response.photo);
    } catch (error) {
      setStatus(item, 'error', error instanceof ApiError ? error.message : '上传失败');
      item.stageNode.textContent = '可重试';
    }
  };

  const pump = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    updateOverall();
    while (true) {
      const item = queue.find((entry) => entry.status === 'queued');
      if (!item) break;
      await processItem(item);
    }
    processing = false;
    updateOverall();
  };

  const createQueueItem = (file: File): QueueItem => {
    const thumb = el('img', { className: 'queue-thumb', alt: '' });
    const stageNode = el('div', { className: 'queue-stage', text: '等待中' });
    const progressNode = el('progress', { max: 100, value: 0 });
    const statusNode = el('div', { className: 'queue-status', text: '等待' });
    const cancelButton = el('button', {
      className: 'mini-button',
      type: 'button',
      'data-action': 'cancel-upload',
      text: '取消',
    });
    const retryButton = el('button', {
      className: 'mini-button',
      type: 'button',
      'data-action': 'retry-upload',
      text: '重试',
    });
    retryButton.hidden = true;
    const node = el('li', { className: 'queue-item' }, [
      thumb,
      el('div', { className: 'queue-main' }, [
        el('div', { className: 'queue-name', text: file.name }),
        stageNode,
        progressNode,
      ]),
      el('div', {}, [statusNode, cancelButton, retryButton]),
    ]);
    const item: QueueItem = {
      id: nextId++,
      file,
      status: 'queued',
      stage: '等待中',
      progress: 0,
      node,
      thumb,
      stageNode,
      statusNode,
      progressNode,
      cancelButton,
      retryButton,
    };
    node.dataset.queueId = String(item.id);
    return item;
  };

  const addFiles = (files: File[]): void => {
    if (!albumId()) {
      toast('请先选择目标相册', 'error');
      return;
    }
    const accepted = files.filter(isImageFile);
    const tooLarge = accepted.filter((file) => file.size > MAX_FILE_BYTES);
    const usable = accepted.filter((file) => file.size <= MAX_FILE_BYTES);
    if (tooLarge.length) {
      toast(`${tooLarge.length} 个文件超过 100MB，已跳过`, 'error');
    }
    if (usable.length === 0) {
      if (accepted.length === 0) toast('没有找到支持的照片', 'error');
      return;
    }
    if (progressBox) progressBox.hidden = false;
    for (const file of usable) {
      const item = createQueueItem(file);
      queue.push(item);
      queueList.append(item.node);
    }
    updateOverall();
    void pump();
  };

  worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    const item = queue.find((entry) => entry.id === message.id);
    if (!item) return;
    if (message.type === 'progress') {
      item.stageNode.textContent = message.message;
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.type === 'result') waiter.resolve(message);
    else waiter.reject(new Error(message.error));
  });

  worker.addEventListener('error', (event) => {
    toast(`转码 Worker 出错：${event.message}`, 'error');
    for (const [id, waiter] of pending) {
      waiter.reject(new Error('转码 Worker 出错'));
      pending.delete(id);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'pick-files') {
      event.preventDefault();
      fileInput.click();
    } else if (action === 'pick-folder') {
      event.preventDefault();
      folderInput.click();
    } else if (action === 'cancel-upload') {
      const node = target?.closest<HTMLElement>('.queue-item');
      const id = Number(node?.dataset.queueId ?? 0);
      const item = queue.find((entry) => entry.id === id);
      if (item && (item.status === 'queued' || item.status === 'processing')) {
        item.status = 'cancelled';
        setStatus(item, 'cancelled', '已取消');
        item.stageNode.textContent = '已取消';
      }
    } else if (action === 'retry-upload') {
      const node = target?.closest<HTMLElement>('.queue-item');
      const id = Number(node?.dataset.queueId ?? 0);
      const item = queue.find((entry) => entry.id === id);
      if (item && item.status === 'error') {
        item.result = undefined;
        item.error = undefined;
        item.progressNode.value = 0;
        item.stageNode.textContent = '等待中';
        setStatus(item, 'queued', '等待');
        void pump();
      }
    }
  });

  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    addFiles(Array.from(folderInput.files ?? []));
    folderInput.value = '';
  });

  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragover');
    if (!event.dataTransfer) return;
    void filesFromDataTransfer(event.dataTransfer).then(addFiles);
  });

  document.addEventListener('album-created', (event) => {
    const album = (event as CustomEvent<AlbumDTO>).detail;
    const option = document.createElement('option');
    option.value = String(album.id);
    option.textContent = album.name;
    albumSelect.append(option);
    albumSelect.value = String(album.id);
    toast(`已创建相册「${album.name}」`);
  });

  albumSelect.addEventListener('change', () => {
    if (albumSelect.value) toast('已选择相册');
  });

}

setupCommon();
setupUpload();
