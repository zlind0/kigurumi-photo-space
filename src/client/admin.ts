import './styles/app.css';
import type { AdminStats, AdminUserDTO, AuditLogDTO, PersonDTO, UserRole } from '../shared/types.js';
import { api, ApiError, formatBytes, formatDate, toast } from './api.js';
import { encodeAvatar } from './avatar.js';
import { setupCommon } from './common.js';
import { el } from './dom.js';
import { closeDialog, confirmDialog, openDialog, setupBackdropClose } from './ui.js';

interface LogsResponse {
  logs: AuditLogDTO[];
  nextCursor: string | null;
}

interface UsersResponse {
  users: AdminUserDTO[];
}

interface PeopleResponse {
  people: PersonDTO[];
}

const ROLE_LABEL: Record<UserRole, string> = {
  admin: '管理员',
  uploader: '上传者',
  viewer: '查看者',
};

function setupAdmin(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
  const panels: Record<string, HTMLElement | null> = {
    logs: document.querySelector('#panel-logs'),
    users: document.querySelector('#panel-users'),
    people: document.querySelector('#panel-people'),
    stats: document.querySelector('#panel-stats'),
  };
  const logRows = document.querySelector<HTMLTableSectionElement>('#log-rows');
  const logMore = document.querySelector<HTMLButtonElement>('#log-more');
  const logFilter = document.querySelector<HTMLFormElement>('#log-filter');
  const userRows = document.querySelector<HTMLTableSectionElement>('#user-rows');
  const personRows = document.querySelector<HTMLTableSectionElement>('#person-rows');
  const statsGrid = document.querySelector<HTMLElement>('#stats-grid');
  const userDialog = document.querySelector<HTMLDialogElement>('#user-dialog');
  const userForm = document.querySelector<HTMLFormElement>('#user-form');
  const userRole = document.querySelector<HTMLSelectElement>('#user-role');
  const userPassword = document.querySelector<HTMLInputElement>('#user-password');
  const userError = document.querySelector<HTMLElement>('#user-error');
  const passwordDialog = document.querySelector<HTMLDialogElement>('#password-dialog');
  const passwordForm = document.querySelector<HTMLFormElement>('#password-form');
  const passwordValue = document.querySelector<HTMLInputElement>('#password-value');
  const passwordError = document.querySelector<HTMLElement>('#password-error');
  const passwordTarget = document.querySelector<HTMLElement>('#password-target');
  const confirmDialogEl = document.querySelector<HTMLDialogElement>('#confirm-dialog');
  const confirmMessage = document.querySelector<HTMLElement>('#confirm-message');
  const confirmOk = document.querySelector<HTMLButtonElement>('#confirm-ok');
  const personDialog = document.querySelector<HTMLDialogElement>('#person-dialog');
  const personForm = document.querySelector<HTMLFormElement>('#person-form');
  const personTitle = document.querySelector<HTMLElement>('#person-dialog-title');
  const personName = document.querySelector<HTMLInputElement>('#person-name');
  const personAvatar = document.querySelector<HTMLInputElement>('#person-avatar');
  const personError = document.querySelector<HTMLElement>('#person-error');
  const personAvatarPreview = document.querySelector<HTMLElement>('#person-avatar-preview');
  const personAvatarImage = document.querySelector<HTMLImageElement>('#person-avatar-image');
  const accentHue = document.querySelector<HTMLInputElement>('#accent-hue');
  const accentSaturation = document.querySelector<HTMLInputElement>('#accent-saturation');
  const accentLightness = document.querySelector<HTMLInputElement>('#accent-lightness');
  const accentHueValue = document.querySelector<HTMLOutputElement>('#accent-hue-value');
  const accentSaturationValue = document.querySelector<HTMLOutputElement>('#accent-saturation-value');
  const accentLightnessValue = document.querySelector<HTMLOutputElement>('#accent-lightness-value');
  const accentPreview = document.querySelector<HTMLElement>('#accent-preview');
  setupBackdropClose(userDialog);
  setupBackdropClose(passwordDialog);
  setupBackdropClose(confirmDialogEl);
  setupBackdropClose(personDialog);

  let logCursor: string | null = null;
  let logFilters = new URLSearchParams();
  let resetUserId: number | null = null;
  let confirmAction: (() => Promise<void>) | null = null;
  let editingPersonId: number | null = null;
  let avatarPreviewUrl: string | null = null;

  const switchTab = (name: string) => {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) panel.hidden = key !== name;
    }
    if (name === 'users') void loadUsers();
    if (name === 'people') void loadPeople();
    if (name === 'stats') void loadStats();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab ?? 'logs'));
  }

  const renderLogs = (logs: AuditLogDTO[], append: boolean) => {
    if (!logRows) return;
    if (!append) logRows.replaceChildren();
    if (logs.length === 0 && !append) {
      logRows.append(el('tr', {}, [el('td', { colspan: 6, className: 'muted', text: '没有日志' })]));
      return;
    }
    for (const log of logs) {
      const detail = log.detail === null ? '' : JSON.stringify(log.detail);
      logRows.append(
        el('tr', {}, [
          el('td', { text: formatDate(log.ts) }),
          el('td', { text: log.userId ? `#${log.userId} ${log.role ? ROLE_LABEL[log.role] : ''}` : '—' }),
          el('td', { text: log.action }),
          el('td', { text: log.targetType ? `${log.targetType} ${log.targetId ?? ''}` : '—' }),
          el('td', { text: log.ip ?? '—' }),
          el('td', { className: 'detail', text: detail.length > 200 ? `${detail.slice(0, 200)}…` : detail }),
        ]),
      );
    }
  };

  const loadLogs = async (append = false) => {
    if (!logRows) return;
    if (!append) {
      logRows.replaceChildren(el('tr', {}, [el('td', { colspan: 6, className: 'muted', text: '加载中…' })]));
    }
    const params = new URLSearchParams(logFilters);
    params.set('limit', '50');
    if (append && logCursor) params.set('cursor', logCursor);
    try {
      const result = await api<LogsResponse>(`/api/admin/logs?${params.toString()}`);
      renderLogs(result.logs, append);
      logCursor = result.nextCursor;
      if (logMore) logMore.hidden = !result.nextCursor;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载日志失败', 'error');
    }
  };

  logFilter?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(logFilter);
    logFilters = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string' && value.trim()) logFilters.set(key, value.trim());
    }
    logCursor = null;
    void loadLogs(false);
  });

  logMore?.addEventListener('click', () => void loadLogs(true));

  const renderUsers = (users: AdminUserDTO[]) => {
    if (!userRows) return;
    userRows.replaceChildren();
    if (users.length === 0) {
      userRows.append(el('tr', {}, [el('td', { colspan: 6, className: 'muted', text: '没有用户' })]));
      return;
    }
    for (const user of users) {
      const actions = el('div', { className: 'photo-actions' }, [
        el('button', { className: 'mini-button', type: 'button', 'data-action': 'reset-password', 'data-user-id': user.id, text: '重置密码' }),
        el('button', {
          className: 'mini-button',
          type: 'button',
          'data-action': user.disabled ? 'enable-user' : 'disable-user',
          'data-user-id': user.id,
          text: user.disabled ? '启用' : '禁用',
        }),
        el('button', { className: 'mini-button danger', type: 'button', 'data-action': 'delete-user', 'data-user-id': user.id, text: '删除' }),
      ]);
      userRows.append(
        el('tr', {}, [
          el('td', { text: `#${user.id}` }),
          el('td', { text: ROLE_LABEL[user.role] }),
          el('td', { text: formatDate(user.createdAt) }),
          el('td', { text: formatDate(user.lastLoginAt) }),
          el('td', { text: user.disabled ? '已禁用' : '启用' }),
          el('td', {}, [actions]),
        ]),
      );
    }
  };

  const loadUsers = async () => {
    if (!userRows) return;
    userRows.replaceChildren(el('tr', {}, [el('td', { colspan: 6, className: 'muted', text: '加载中…' })]));
    try {
      const result = await api<UsersResponse>('/api/admin/users');
      renderUsers(result.users);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载用户失败', 'error');
    }
  };

  const updateAccentPreview = () => {
    const hue = Number(accentHue?.value ?? 330);
    const saturation = Number(accentSaturation?.value ?? 70);
    const lightness = Number(accentLightness?.value ?? 80);
    if (accentHueValue) accentHueValue.textContent = String(hue);
    if (accentSaturationValue) accentSaturationValue.textContent = String(saturation);
    if (accentLightnessValue) accentLightnessValue.textContent = String(lightness);
    if (accentPreview) {
      accentPreview.style.background = `hsl(${hue} ${saturation}% ${lightness}%)`;
    }
  };

  const resetPersonForm = (person: PersonDTO | null) => {
    editingPersonId = person?.id ?? null;
    if (personTitle) personTitle.textContent = person ? '编辑人物' : '添加人物';
    if (personName) personName.value = person?.name ?? '';
    if (personAvatar) personAvatar.value = '';
    if (personError) personError.textContent = '';
    if (accentHue) accentHue.value = String(person?.hue ?? 330);
    if (accentSaturation) accentSaturation.value = String(person?.saturation ?? 70);
    if (accentLightness) accentLightness.value = String(person?.lightness ?? 80);
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
      avatarPreviewUrl = null;
    }
    if (personAvatarPreview) personAvatarPreview.hidden = true;
    if (personAvatarImage) personAvatarImage.removeAttribute('src');
    updateAccentPreview();
  };

  const renderPeople = (people: PersonDTO[]) => {
    if (!personRows) return;
    personRows.replaceChildren();
    if (people.length === 0) {
      personRows.append(el('tr', {}, [el('td', { colspan: 5, className: 'muted', text: '还没有人物' })]));
      return;
    }
    for (const person of people) {
      const avatar = el('span', { className: 'admin-person-avatar', style: `--person-accent:${person.accent}` }, [
        el('img', { src: person.avatarUrl, alt: person.name, width: 200, height: 200, loading: 'lazy' }),
      ]);
      const swatch = el('span', { className: 'accent-swatch', style: `background:${person.accent}` });
      const actions = el('div', { className: 'photo-actions' }, [
        el('button', { className: 'mini-button', type: 'button', 'data-action': 'edit-person', 'data-person-id': person.id, text: '编辑' }),
        el('button', { className: 'mini-button danger', type: 'button', 'data-action': 'delete-person', 'data-person-id': person.id, text: '删除' }),
      ]);
      personRows.append(
        el('tr', {}, [
          el('td', {}, [avatar]),
          el('td', { text: person.name }),
          el('td', {}, [swatch, el('span', { className: 'muted', text: ` ${person.accent}` })]),
          el('td', { text: formatDate(person.createdAt) }),
          el('td', {}, [actions]),
        ]),
      );
    }
  };

  const loadPeople = async () => {
    if (!personRows) return;
    personRows.replaceChildren(el('tr', {}, [el('td', { colspan: 5, className: 'muted', text: '加载中…' })]));
    try {
      const result = await api<PeopleResponse>('/api/people');
      renderPeople(result.people);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载人物失败', 'error');
    }
  };

  const loadStats = async () => {
    if (!statsGrid) return;
    statsGrid.replaceChildren(el('div', { className: 'muted', text: '加载中…' }));
    try {
      const stats = await api<AdminStats>('/api/admin/stats');
      const cards: Array<[string, string]> = [
        ['相册', String(stats.albums)],
        ['照片', String(stats.photos)],
        ['用户', String(stats.users)],
        ['照片占用', formatBytes(stats.totalBytes)],
        ['磁盘剩余', formatBytes(stats.diskFree)],
        ['磁盘总量', formatBytes(stats.diskTotal)],
      ];
      statsGrid.replaceChildren(
        ...cards.map(([label, value]) =>
          el('div', { className: 'stat-card' }, [el('dt', { text: label }), el('dd', { text: value })]),
        ),
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载统计失败', 'error');
    }
  };

  const openConfirm = (message: string, action: () => Promise<void>) => {
    if (!confirmDialogEl || !confirmMessage) return;
    confirmMessage.textContent = message;
    confirmAction = action;
    openDialog(confirmDialogEl);
  };

  confirmOk?.addEventListener('click', () => {
    const action = confirmAction;
    confirmAction = null;
    closeDialog(confirmDialogEl);
    if (action) void action();
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const actionNode = target?.closest<HTMLElement>('[data-action]');
    if (!actionNode) return;
    const action = actionNode.dataset.action;
    const userId = Number(actionNode.dataset.userId ?? 0);
    if (action === 'new-user') {
      event.preventDefault();
      if (userError) userError.textContent = '';
      if (userPassword) userPassword.value = '';
      if (userRole) userRole.value = 'viewer';
      openDialog(userDialog);
      return;
    }
    if (action === 'new-person') {
      event.preventDefault();
      resetPersonForm(null);
      openDialog(personDialog);
      window.setTimeout(() => personName?.focus(), 30);
      return;
    }
    if (action === 'edit-person') {
      event.preventDefault();
      const personId = Number(actionNode.dataset.personId ?? 0);
      if (!personId) return;
      void api<PeopleResponse>('/api/people')
        .then((result) => {
          const person = result.people.find((entry) => entry.id === personId);
          if (!person) {
            toast('人物不存在', 'error');
            return;
          }
          resetPersonForm(person);
          openDialog(personDialog);
        })
        .catch((error) => toast(error instanceof ApiError ? error.message : '加载人物失败', 'error'));
      return;
    }
    if (action === 'delete-person') {
      event.preventDefault();
      const personId = Number(actionNode.dataset.personId ?? 0);
      if (!personId) return;
      openConfirm(`删除人物 #${personId}？相册中的人物标记也会一并移除。`, async () => {
        try {
          await api(`/api/admin/people/${personId}`, { method: 'DELETE' });
          toast('人物已删除');
          await loadPeople();
        } catch (error) {
          toast(error instanceof ApiError ? error.message : '删除失败', 'error');
        }
      });
      return;
    }
    if (action === 'close-person-dialog') {
      closeDialog(personDialog);
      return;
    }
    if (action === 'close-user-dialog') {
      closeDialog(userDialog);
      return;
    }
    if (action === 'close-password-dialog') {
      closeDialog(passwordDialog);
      return;
    }
    if (action === 'close-confirm') {
      closeDialog(confirmDialogEl);
      return;
    }
    if (action === 'reset-password' && userId) {
      event.preventDefault();
      resetUserId = userId;
      if (passwordTarget) passwordTarget.textContent = `用户 #${userId}`;
      if (passwordValue) passwordValue.value = '';
      if (passwordError) passwordError.textContent = '';
      openDialog(passwordDialog);
      return;
    }
    if ((action === 'disable-user' || action === 'enable-user') && userId) {
      event.preventDefault();
      const disabled = action === 'disable-user';
      void api(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled }),
      })
        .then(() => loadUsers())
        .catch((error) => toast(error instanceof ApiError ? error.message : '更新失败', 'error'));
      return;
    }
    if (action === 'delete-user' && userId) {
      event.preventDefault();
      openConfirm(`删除用户 #${userId}？该用户的所有会话会立即失效。`, async () => {
        try {
          await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
          toast('用户已删除');
          await loadUsers();
        } catch (error) {
          toast(error instanceof ApiError ? error.message : '删除失败', 'error');
        }
      });
    }
  });

  for (const input of [accentHue, accentSaturation, accentLightness]) {
    input?.addEventListener('input', updateAccentPreview);
  }

  personAvatar?.addEventListener('change', () => {
    const file = personAvatar.files?.[0];
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
      avatarPreviewUrl = null;
    }
    if (!file || !personAvatarImage || !personAvatarPreview) {
      if (personAvatarPreview) personAvatarPreview.hidden = true;
      return;
    }
    avatarPreviewUrl = URL.createObjectURL(file);
    personAvatarImage.src = avatarPreviewUrl;
    personAvatarPreview.hidden = false;
  });

  personForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = personName?.value.trim() ?? '';
    if (!name) {
      if (personError) personError.textContent = '请输入人物名';
      return;
    }
    const file = personAvatar?.files?.[0] ?? null;
    if (!editingPersonId && !file) {
      if (personError) personError.textContent = '请选择头像';
      return;
    }
    const submit = personForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    if (personError) personError.textContent = file ? '正在编码头像…' : '';
    try {
      const form = new FormData();
      form.set('name', name);
      form.set('hue', accentHue?.value ?? '330');
      form.set('saturation', accentSaturation?.value ?? '70');
      form.set('lightness', accentLightness?.value ?? '80');
      if (file) {
        const avatar = await encodeAvatar(file);
        form.set('avatar', avatar, 'avatar.avif');
      }
      if (personError) personError.textContent = '正在保存…';
      if (editingPersonId) {
        await api(`/api/admin/people/${editingPersonId}`, { method: 'PATCH', body: form });
      } else {
        await api('/api/admin/people', { method: 'POST', body: form });
      }
      closeDialog(personDialog);
      toast(editingPersonId ? '人物已更新' : '人物已添加');
      await loadPeople();
    } catch (error) {
      if (personError) personError.textContent = error instanceof ApiError ? error.message : '保存失败';
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  userForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const role = userRole?.value ?? 'viewer';
    const password = userPassword?.value ?? '';
    try {
      const result = await api<{ user: AdminUserDTO; password?: string }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ role, password: password || undefined }),
      });
      closeDialog(userDialog);
      if (result.password) {
        window.alert(`用户 #${result.user.id} 已创建。\n密码（只显示一次）：${result.password}`);
      } else {
        toast('用户已创建');
      }
      await loadUsers();
    } catch (error) {
      if (userError) userError.textContent = error instanceof ApiError ? error.message : '创建失败';
    }
  });

  passwordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!resetUserId) return;
    const password = passwordValue?.value ?? '';
    try {
      const result = await api<{ user: AdminUserDTO; password?: string }>(`/api/admin/users/${resetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: password || undefined }),
      });
      closeDialog(passwordDialog);
      if (result.password) {
        window.alert(`用户 #${resetUserId} 的密码已重置。\n新密码（只显示一次）：${result.password}`);
      } else {
        toast('密码已重置');
      }
      await loadUsers();
    } catch (error) {
      if (passwordError) passwordError.textContent = error instanceof ApiError ? error.message : '重置失败';
    }
  });

  void loadLogs(false);
}

setupCommon();
setupAdmin();
