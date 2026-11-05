import type { AlbumDTO, Role } from '../../shared/types.js';
import { escapeHtml } from '../http/errors.js';
import { renderLayout, type AssetManifest } from './layout.js';

export interface UploadPageOptions {
  albums: AlbumDTO[];
  role: Role;
  authenticated: boolean;
  selectedAlbumId: number | null;
  manifest: AssetManifest;
}

export function renderUploadPage(options: UploadPageOptions): string {
  const optionsHtml = options.albums
    .map(
      (album) =>
        `<option value="${album.id}"${album.id === options.selectedAlbumId ? ' selected' : ''}>${escapeHtml(album.name)}${album.visibility === 'private' ? '（私密）' : ''}</option>`,
    )
    .join('');
  const body = `<section class="page-heading">
  <div>
    <h1>上传照片</h1>
    <p class="muted">照片在你的浏览器里转码为 AVIF，原图不会上传。HDR 照片会保留为 10-bit HDR AVIF。</p>
  </div>
</section>
<section class="upload-panel" id="upload-app" data-selected-album="${options.selectedAlbumId ?? ''}">
  <div class="upload-target">
    <label class="field">
      <span>目标相册</span>
      <select id="album-select">
        <option value="">选择相册…</option>
        ${optionsHtml}
      </select>
    </label>
    <button class="button" type="button" data-action="new-album">新建相册</button>
  </div>
  <div class="drop-zone" id="drop-zone" tabindex="0" role="button" aria-label="拖拽照片或文件夹到这里，或点击选择">
    <p class="drop-title">把照片或整个文件夹拖到这里</p>
    <p class="muted">支持 JPEG、PNG、WebP、HEIC/HEIF、AVIF。单文件最大 100MB，最大 80MP。</p>
    <div class="drop-actions">
      <button class="button primary" type="button" data-action="pick-files">选择照片</button>
      <button class="button" type="button" data-action="pick-folder">选择文件夹</button>
    </div>
    <input id="file-input" type="file" multiple accept="image/avif,image/heic,image/heif,image/jpeg,image/png,image/webp" hidden>
    <input id="folder-input" type="file" multiple webkitdirectory directory hidden>
  </div>
  <div class="upload-progress" id="upload-progress" hidden>
    <div class="progress-row"><span id="progress-label">准备中…</span><span id="progress-count">0 / 0</span></div>
    <progress id="overall-progress" max="100" value="0"></progress>
  </div>
  <ul class="upload-queue" id="upload-queue" aria-live="polite"></ul>
  <section class="upload-results" id="upload-results" hidden>
    <h2>本次上传</h2>
    <p class="muted">可以在这里把本次上传的照片设为封面、精选或其他，或删除。</p>
    <ul class="photo-grid" id="upload-results-grid"></ul>
  </section>
  <p class="upload-note">请保持页面打开，直到所有照片上传完成。转码在本地进行，不会消耗服务器 CPU。</p>
</section>
<dialog id="new-album-dialog" class="dialog" aria-labelledby="new-album-title">
  <form id="new-album-form" method="dialog" novalidate>
    <h2 id="new-album-title">新建相册</h2>
    <label class="field">
      <span>相册名</span>
      <input id="new-album-name" name="name" type="text" maxlength="80" required autofocus placeholder="例如：2026 春">
    </label>
    <p id="new-album-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-new-album">取消</button>
      <button type="submit" class="button primary">创建</button>
    </div>
  </form>
</dialog>`;
  return renderLayout({
    title: '上传 · Kig Photo Space',
    body,
    role: options.role,
    authenticated: options.authenticated,
    active: 'upload',
    assets: options.manifest.entry('upload/index.ts'),
    bodyClass: 'upload-body',
  });
}
