import type { AlbumListResponse } from '../shared/types.js';
import { api, ApiError, toast } from './api.js';
import { albumCard } from './dom.js';
import { closeDialog, openDialog, setupBackdropClose } from './ui.js';

/**
 * 人物区域优先一行显示；一行放不下时按 50px 下限算出需要的行数，
 * 再把人物平均分配到各行，避免出现 9 + 1 这种尾巴。
 */
function setupPeopleGridLayout(grid: HTMLUListElement): void {
  let frame = 0;

  const apply = () => {
    frame = 0;
    const count = grid.children.length;
    const width = grid.clientWidth;
    if (count === 0 || width === 0) return;
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    const maxSize = 100;
    const minSize = 50;
    let columns = count;
    const fitAtMax = Math.floor((width + gap) / (maxSize + gap));
    if (fitAtMax < count) {
      const fitAtMin = Math.max(1, Math.floor((width + gap) / (minSize + gap)));
      const rows = Math.ceil(count / fitAtMin);
      columns = Math.ceil(count / rows);
    }
    const next = String(columns);
    if (grid.style.getPropertyValue('--people-columns') !== next) {
      grid.style.setProperty('--people-columns', next);
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  apply();
  new ResizeObserver(schedule).observe(grid);
  window.addEventListener('resize', schedule);
}

function setupHomePeopleFilter(): void {
  const grid = document.querySelector<HTMLUListElement>('#people-grid');
  const albumGrid = document.querySelector<HTMLUListElement>('#album-grid');
  if (!grid || !albumGrid) return;
  setupPeopleGridLayout(grid);
  const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('[data-person-id]'));
  if (buttons.length === 0) return;
  const allButton = grid.querySelector<HTMLButtonElement>('[data-action="select-all-people"]');
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
    if (allButton) {
      const all = selected === null;
      allButton.classList.toggle('is-selected', all);
      allButton.setAttribute('aria-pressed', all ? 'true' : 'false');
    }
  };

  const renderAlbums = (albums: AlbumListResponse['albums']) => {
    const cards = albums.map((album, index) => albumCard(album, index));
    albumGrid.replaceChildren(...cards);
    if (newCard) albumGrid.append(newCard);
    if (empty) empty.hidden = albums.length > 0 || Boolean(newCard);
  };

  const load = async () => {
    const token = ++requestToken;
    const people = selected === null ? null : Array.from(selected);
    const query = new URLSearchParams({ limit: '100000' });
    if (people && people.length > 0) query.set('people', people.join(','));
    try {
      const result = await api<AlbumListResponse>(`/api/albums?${query.toString()}`);
      if (token !== requestToken) return;
      renderAlbums(result.albums);
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
