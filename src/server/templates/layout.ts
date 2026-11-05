import { readFileSync } from 'node:fs';
import type { Role } from '../../shared/types.js';
import { escapeHtml } from '../http/errors.js';

interface ManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

export interface Assets {
  js: string[];
  css: string[];
}

export class AssetManifest {
  private readonly manifest: Record<string, ManifestEntry>;

  constructor(path: string) {
    try {
      this.manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ManifestEntry>;
    } catch {
      this.manifest = {};
    }
  }

  private allCss(): string[] {
    return Object.values(this.manifest)
      .filter((entry) => entry.file.endsWith('.css'))
      .map((entry) => `/assets/${entry.file.replace(/^assets\//, '')}`);
  }

  entry(source: string): Assets {
    const key = Object.keys(this.manifest).find(
      (candidate) => candidate === source || candidate.endsWith(`/${source}`),
    );
    if (!key) return { js: [], css: this.allCss() };
    const entry = this.manifest[key]!;
    return {
      js: [`/assets/${entry.file.replace(/^assets\//, '')}`],
      css: entry.css?.length
        ? entry.css.map((file) => `/assets/${file.replace(/^assets\//, '')}`)
        : this.allCss(),
    };
  }
}

export interface LayoutOptions {
  title: string;
  body: string;
  role: Role;
  authenticated: boolean;
  active?: 'home' | 'upload' | 'admin';
  assets: Assets;
  description?: string;
  bodyClass?: string;
}

function nav(options: LayoutOptions): string {
  const items: string[] = [];
  items.push(
    `<a class="nav-link${options.active === 'home' ? ' is-active' : ''}" href="/">相册</a>`,
  );
  if (options.role === 'uploader' || options.role === 'admin') {
    items.push(
      `<a class="nav-link${options.active === 'upload' ? ' is-active' : ''}" href="/upload">上传</a>`,
    );
  }
  if (options.role === 'admin') {
    items.push(
      `<a class="nav-link${options.active === 'admin' ? ' is-active' : ''}" href="/admin">管理</a>`,
    );
  }
  if (options.authenticated) {
    items.push(
      `<span class="role-badge" title="当前角色">${roleLabel(options.role)}</span>`,
      `<button class="nav-link" type="button" data-action="logout">退出</button>`,
    );
  } else {
    items.push(`<button class="nav-link nav-login" type="button" data-action="open-login">登录</button>`);
  }
  return items.join('');
}

export function roleLabel(role: Role): string {
  switch (role) {
    case 'admin':
      return '管理员';
    case 'uploader':
      return '上传者';
    case 'viewer':
      return '查看者';
    default:
      return '公众';
  }
}

export function renderLayout(options: LayoutOptions): string {
  const css = options.assets.css
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('');
  const js = options.assets.js
    .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${escapeHtml(options.description ?? '私密照片分享空间')}">
<title>${escapeHtml(options.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${css}
</head>
<body class="${escapeHtml(options.bodyClass ?? '')}" data-role="${options.role}" data-authenticated="${options.authenticated ? '1' : '0'}">
<a class="skip-link" href="#main">跳到主要内容</a>
<header class="site-header">
  <a class="brand" href="/" aria-label="Kig Photo Space 首页">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-text">Kig Photo Space</span>
  </a>
  <nav class="site-nav" aria-label="主导航">${nav(options)}</nav>
</header>
<main id="main" class="site-main">
${options.body}
</main>
<footer class="site-footer">
  <p>照片在浏览器本地转码为 AVIF，服务器只负责存储。</p>
</footer>
<dialog id="login-dialog" class="dialog login-dialog" aria-labelledby="login-title">
  <form id="login-form" method="dialog" novalidate>
    <h2 id="login-title">登录</h2>
    <p class="muted">输入访问密码。没有用户名。</p>
    <label class="field">
      <span>密码</span>
      <input id="login-password" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required autofocus>
    </label>
    <p id="login-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-login">取消</button>
      <button type="submit" class="button primary">登录</button>
    </div>
  </form>
</dialog>
<dialog id="lightbox" class="dialog lightbox" aria-label="照片查看器">
  <div class="lightbox-inner">
    <button type="button" class="lightbox-close" data-action="lightbox-close" aria-label="关闭">×</button>
    <button type="button" class="lightbox-nav prev" data-action="lightbox-prev" aria-label="上一张">‹</button>
    <figure class="lightbox-figure">
      <img id="lightbox-image" alt="" decoding="async">
      <figcaption id="lightbox-caption"></figcaption>
      <div class="lightbox-actions">
        <button type="button" class="button small" data-action="download-avif">下载 AVIF</button>
        <button type="button" class="button small" data-action="download-jpeg">下载 JPEG</button>
      </div>
    </figure>
    <button type="button" class="lightbox-nav next" data-action="lightbox-next" aria-label="下一张">›</button>
  </div>
</dialog>
<noscript><p class="noscript">需要启用 JavaScript 才能登录、上传和查看大图。照片列表仍可直接浏览。</p></noscript>
${js}
</body>
</html>`;
}
