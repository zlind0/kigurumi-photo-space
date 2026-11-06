import type { AlbumListResponse } from '../shared/types.js';
import { api, ApiError, toast } from './api.js';
import { albumCard } from './dom.js';
import { closeDialog, openDialog, setupBackdropClose } from './ui.js';

function setupHomePeopleFilter(): void {
  const grid = document.querySelector<HTMLUListElement>('#people-grid');
  const albumGrid = document.querySelector<HTMLUListElement>('#album-grid');
  if (!grid || !albumGrid) return;
  const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('[data-person-id]'));
  if (buttons.length === 0) return;
  const empty = document.querySelector<HTMLElement>('#people-empty');
  const newCard = albumGrid.querySelector<HTMLElement>('.album-new')?.closest('li') ?? null;
  let selected: Set<number> | null = null;
  let requestToken = 0;

  const updateButtons = () => {
    for (const button of buttons) {
      const id = Number(button.dataset.personId ?? 0);
      const active = selected === null || selected.has(id);
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  };

  const ensureLoadMore = (nextCursor: string | null, people: number[] | null) => {
    let container = document.querySelector<HTMLElement>('.load-more');
    let button = container?.querySelector<HTMLButtonElement>('[data-action="load-more-albums"]') ?? null;
    if (!nextCursor) {
      button?.remove();
      return;
    }
    if (!container) {
      container = document.createElement('div');
      container.className = 'load-more';
      albumGrid.after(container);
    }
    if (!button) {
      button = document.createElement('button');
      button.className = 'button';
      button.type = 'button';
      button.dataset.action = 'load-more-albums';
      button.textContent = '加载更多相册';
      container.append(button);
    }
    button.dataset.cursor = nextCursor;
    if (people && people.length > 0) button.dataset.people = people.join(',');
    else delete button.dataset.people;
  };

  const renderAlbums = (albums: AlbumListResponse['albums'], nextCursor: string | null, people: number[] | null) => {
    const cards = albums.map((album, index) => albumCard(album, index));
    albumGrid.replaceChildren(...cards);
    if (newCard) albumGrid.append(newCard);
    if (empty) empty.hidden = albums.length > 0 || Boolean(newCard);
    ensureLoadMore(nextCursor, people);
  };

  const load = async () => {
    const token = ++requestToken;
    const people = selected === null ? null : Array.from(selected);
    const query = new URLSearchParams({ limit: '50' });
    if (people && people.length > 0) query.set('people', people.join(','));
    try {
      const result = await api<AlbumListResponse>(`/api/albums?${query.toString()}`);
      if (token !== requestToken) return;
      renderAlbums(result.albums, result.nextCursor, people);
    } catch (error) {
      if (token !== requestToken) return;
      toast(error instanceof ApiError ? error.message : '筛选相册失败', 'error');
    }
  };

  grid.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-person-id]');
    if (!button) return;
    event.preventDefault();
    const id = Number(button.dataset.personId ?? 0);
    if (!id) return;
    if (selected === null) {
      selected = new Set([id]);
    } else if (selected.has(id)) {
      selected.delete(id);
      if (selected.size === 0) selected = null;
    } else {
      selected.add(id);
    }
    updateButtons();
    void load();
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action !== 'select-all-people') return;
    event.preventDefault();
    selected = null;
    updateButtons();
    void load();
  });
}

function setupAlbumPeopleEditor(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#album-people-dialog');
  const form = document.querySelector<HTMLFormElement>('#album-people-form');
  if (!dialog || !form) return;
  setupBackdropClose(dialog);
  const error = document.querySelector<HTMLElement>('#album-people-error');
  const page = document.querySelector<HTMLElement>('.album-page');
  const albumId = Number(page?.dataset.albumId ?? 0);

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'edit-album-people') {
      event.preventDefault();
      if (error) error.textContent = '';
      openDialog(dialog);
    } else if (action === 'close-album-people') {
      event.preventDefault();
      closeDialog(dialog);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!albumId) return;
    const personIds = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="person"]:checked')).map(
      (input) => Number(input.value),
    );
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await api(`/api/albums/${albumId}/people`, {
        method: 'PUT',
        body: JSON.stringify({ personIds }),
      });
      closeDialog(dialog);
      window.location.reload();
    } catch (err) {
      if (error) error.textContent = err instanceof ApiError ? err.message : '保存失败';
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

export function setupPeople(): void {
  setupHomePeopleFilter();
  setupAlbumPeopleEditor();
}
