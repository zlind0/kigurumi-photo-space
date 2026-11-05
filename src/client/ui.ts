export function supportsClosedBy(): boolean {
  return 'closedBy' in HTMLDialogElement.prototype;
}

export function openDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  if (dialog.open) return;
  dialog.showModal();
}

export function closeDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog || !dialog.open) return;
  dialog.close();
}

export function setupBackdropClose(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  if (supportsClosedBy()) {
    dialog.setAttribute('closedby', 'any');
    return;
  }
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => {
    downOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener('pointerup', (event) => {
    if (downOnBackdrop && event.target === dialog) dialog.close();
    downOnBackdrop = false;
  });
}

export function confirmDialog(message: string, confirmLabel = '确认'): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    const title = document.createElement('h2');
    title.textContent = '确认操作';
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button ghost';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'button danger';
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);
    dialog.append(title, text, actions);
    document.body.append(dialog);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    dialog.showModal();
    cancel.focus();
  });
}
