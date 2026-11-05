import { api, ApiError } from './api.js';
import { closeDialog, openDialog, setupBackdropClose } from './ui.js';

export function setupLogin(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#login-dialog');
  const form = document.querySelector<HTMLFormElement>('#login-form');
  const password = document.querySelector<HTMLInputElement>('#login-password');
  const error = document.querySelector<HTMLElement>('#login-error');
  if (!dialog || !form || !password || !error) return;
  setupBackdropClose(dialog);

  const open = () => {
    error.textContent = '';
    openDialog(dialog);
    window.setTimeout(() => password.focus(), 30);
  };

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'open-login') {
      event.preventDefault();
      open();
    } else if (action === 'close-login') {
      closeDialog(dialog);
    } else if (action === 'logout') {
      event.preventDefault();
      void logout();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = password.value;
    if (value.length < 8) {
      error.textContent = '密码至少 8 个字符';
      return;
    }
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    error.textContent = '';
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: value }),
      });
      window.location.reload();
    } catch (err) {
      error.textContent = err instanceof ApiError ? err.message : '登录失败，请重试';
      password.select();
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

async function logout(): Promise<void> {
  try {
    await api('/api/logout', { method: 'POST' });
  } finally {
    window.location.reload();
  }
}
