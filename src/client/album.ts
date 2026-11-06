import type { AlbumDTO, AlbumListResponse, PhotoDTO, PhotoListResponse, Visibility } from '../shared/types.js';
import { api, ApiError, toast } from './api.js';
import { albumCard, photoCard } from './dom.js';
import { closeDialog, confirmDialog, openDialog, setupBackdropClose } from './ui.js';

function albumIdFromPage(): number | null {
  const page = document.querySelector<HTMLElement>('.album-page');
  const id = Number(page?.dataset.albumId ?? 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function setupAlbumActions(): void {
  const newAlbumDialog = document.querySelector<HTMLDialogElement>('#new-album-dialog');
  const newAlbumForm = document.querySelector<HTMLFormElement>('#new-album-form');
  const newAlbumName = document.querySelector<HTMLInputElement>('#new-album-name');
  const newAlbumError = document.querySelector<HTMLElement>('#new-album-error');
  setupBackdropClose(newAlbumDialog);

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const actionNode = target?.closest<HTMLElement>('[data-action]');
    if (!actionNode) return;
    const action = actionNode.dataset.action;
    if (action === 'new-album') {
      event.preventDefault();
      if (newAlbumError) newAlbumError.textContent = '';
      if (newAlbumName) newAlbumName.value = '';
      openDialog(newAlbumDialog);
      window.setTimeout(() => newAlbumName?.focus(), 30);
      return;
    }
    if (action === 'close-new-album') {
      closeDialog(newAlbumDialog);
      return;
    }
    if (action === 'load-more-photos') {
      event.preventDefault();
      void loadMorePhotos(actionNode as HTMLButtonElement);
      return;
    }
    if (action === 'load-more-albums') {
      event.preventDefault();
      void loadMoreAlbums(actionNode as HTMLButtonElement);
      return;
    }
    if (action === 'set-tier') {
      event.preventDefault();
      void setTier(actionNode as HTMLButtonElement);
      return;
    }
    if (action === 'set-visibility') {
      event.preventDefault();
      void setVisibility(actionNode as HTMLButtonElement);
      return;
    }
    if (action === 'delete-photo') {
      event.preventDefault();
      void removePhoto(actionNode);
      return;
    }
    if (action === 'delete-album') {
      event.preventDefault();
      void removeAlbum();
      return;
    }
    if (action === 'toggle-album-visibility') {
      event.preventDefault();
      void toggleAlbumVisibility(actionNode);
    }
  });

  newAlbumForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = newAlbumName?.value.trim() ?? '';
    if (!name) {
      if (newAlbumError) newAlbumError.textContent = '请输入相册名';
      return;
    }
    const submit = newAlbumForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const result = await api<{ album: AlbumDTO }>('/api/albums', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      closeDialog(newAlbumDialog);
      if (document.querySelector('#upload-app')) {
        document.dispatchEvent(new CustomEvent<AlbumDTO>('album-created', { detail: result.album }));
      } else {
        window.location.href = `/a/${encodeURIComponent(result.album.dir)}`;
      }
    } catch (error) {
      if (newAlbumError) {
        newAlbumError.textContent = error instanceof ApiError ? error.message : '创建失败';
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

async function loadMorePhotos(button: HTMLButtonElement): Promise<void> {
  const albumId = albumIdFromPage();
  const grid = document.querySelector<HTMLUListElement>('#photo-grid');
  if (!albumId || !grid) return;
  const cursor = button.dataset.cursor;
  button.disabled = true;
  try {
    const result = await api<PhotoListResponse>(
      `/api/albums/${albumId}/photos?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    for (const photo of result.items) grid.append(photoCard(photo));
    if (result.nextCursor) {
      button.dataset.cursor = result.nextCursor;
    } else {
      button.remove();
    }
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '加载失败', 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadMoreAlbums(button: HTMLButtonElement): Promise<void> {
  const grid = document.querySelector<HTMLUListElement>('#album-grid');
  if (!grid) return;
  const cursor = button.dataset.cursor;
  const people = button.dataset.people;
  button.disabled = true;
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (cursor) params.set('cursor', cursor);
    if (people) params.set('people', people);
    const result = await api<AlbumListResponse>(`/api/albums?${params.toString()}`);
    const newCard = grid.querySelector('.album-new')?.closest('li') ?? null;
    for (const album of result.albums) {
      grid.insertBefore(albumCard(album, 1), newCard);
    }
    if (result.nextCursor) {
      button.dataset.cursor = result.nextCursor;
    } else {
      button.remove();
    }
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '加载失败', 'error');
  } finally {
    button.disabled = false;
  }
}

async function setTier(button: HTMLButtonElement): Promise<void> {
  const card = button.closest<HTMLElement>('.photo-item');
  const id = Number(card?.dataset.photoId ?? 0);
  const tier = button.dataset.tier;
  if (!card || !id || !tier) return;
  const oldTier = card.dataset.tier;
  button.disabled = true;
  try {
    const result = await api<{ photo: PhotoDTO }>(`/api/photos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ tier }),
    });
    if (oldTier === 'cover' || result.photo.tier === 'cover') {
      window.location.reload();
      return;
    }
    card.replaceWith(photoCard(result.photo));
    toast('已更新照片档次');
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '更新失败', 'error');
  } finally {
    button.disabled = false;
  }
}

async function setVisibility(button: HTMLButtonElement): Promise<void> {
  const card = button.closest<HTMLElement>('.photo-item');
  const id = Number(card?.dataset.photoId ?? 0);
  const visibility = button.dataset.visibility;
  if (!card || !id || !visibility) return;
  button.disabled = true;
  try {
    const result = await api<{ photo: PhotoDTO; albumVisibility?: Visibility }>(`/api/photos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    });
    const page = document.querySelector<HTMLElement>('.album-page');
    if (
      result.albumVisibility &&
      page?.dataset.albumVisibility &&
      result.albumVisibility !== page.dataset.albumVisibility
    ) {
      // 相册因为所有照片转私密而自动转私密，刷新以更新头部状态。
      window.location.reload();
      return;
    }
    if (result.photo.tier === 'cover') {
      window.location.reload();
      return;
    }
    card.replaceWith(photoCard(result.photo));
    toast(visibility === 'private' ? '已设为私密' : '已设为公开');
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '更新失败', 'error');
  } finally {
    button.disabled = false;
  }
}

async function removePhoto(button: HTMLElement): Promise<void> {
  const card = button.closest<HTMLElement>('.photo-item');
  const id = Number(card?.dataset.photoId ?? 0);
  if (!card || !id) return;
  if (!(await confirmDialog('删除这张照片？此操作不可撤销。', '删除'))) return;
  try {
    await api(`/api/photos/${id}`, { method: 'DELETE' });
    if (card.dataset.tier === 'cover') {
      window.location.reload();
      return;
    }
    card.remove();
    toast('照片已删除');
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '删除失败', 'error');
  }
}

async function removeAlbum(): Promise<void> {
  const albumId = albumIdFromPage();
  if (!albumId) return;
  if (!(await confirmDialog('删除整个相册？照片会进入回收站，管理员可在服务器上恢复。', '删除相册'))) return;
  try {
    await api(`/api/albums/${albumId}`, { method: 'DELETE' });
    window.location.href = '/';
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '删除失败', 'error');
  }
}

async function toggleAlbumVisibility(button: HTMLElement): Promise<void> {
  const albumId = albumIdFromPage();
  const visibility = button.dataset.visibility;
  if (!albumId || !visibility) return;
  try {
    await api(`/api/albums/${albumId}`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    });
    window.location.reload();
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '更新失败', 'error');
  }
}
