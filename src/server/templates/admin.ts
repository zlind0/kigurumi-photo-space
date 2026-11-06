import type { Role } from '../../shared/types.js';
import { renderLayout, type AssetManifest } from './layout.js';

export interface AdminPageOptions {
  role: Role;
  authenticated: boolean;
  manifest: AssetManifest;
}

export function renderAdminPage(options: AdminPageOptions): string {
  const body = `<section class="page-heading">
  <div>
    <h1>管理台</h1>
    <p class="muted">操作日志、用户管理与站点统计。</p>
  </div>
</section>
<div class="tabs" role="tablist" aria-label="管理台分区">
  <button class="tab is-active" type="button" role="tab" aria-selected="true" data-tab="logs">操作日志</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="users">用户管理</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="people">人物</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="stats">统计</button>
</div>
<section class="tab-panel" id="panel-logs" role="tabpanel">
  <form class="filter-bar" id="log-filter">
    <label class="field inline"><span>动作</span><input name="action" type="text" placeholder="如 photo.upload"></label>
    <label class="field inline"><span>用户 ID</span><input name="userId" type="number" min="1" inputmode="numeric"></label>
    <label class="field inline"><span>从</span><input name="from" type="date"></label>
    <label class="field inline"><span>到</span><input name="to" type="date"></label>
    <button class="button" type="submit">筛选</button>
  </form>
  <div class="table-wrap">
    <table class="data-table">
      <thead><tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>IP</th><th>详情</th></tr></thead>
      <tbody id="log-rows"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
    </table>
  </div>
  <div class="load-more"><button class="button" type="button" id="log-more" hidden>加载更多</button></div>
</section>
<section class="tab-panel" id="panel-users" role="tabpanel" hidden>
  <div class="section-heading"><h2>用户</h2><button class="button primary" type="button" data-action="new-user">新建用户</button></div>
  <div class="table-wrap">
    <table class="data-table">
      <thead><tr><th>ID</th><th>角色</th><th>创建时间</th><th>最后登录</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="user-rows"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
    </table>
  </div>
</section>
<section class="tab-panel" id="panel-people" role="tabpanel" hidden>
  <div class="section-heading"><h2>人物</h2><button class="button primary" type="button" data-action="new-person">添加人物</button></div>
  <p class="muted">人物会显示在首页顶部，用于按人物筛选相册。头像会裁剪为 200×200 的圆形 AVIF。</p>
  <div class="table-wrap">
    <table class="data-table">
      <thead><tr><th>头像</th><th>名字</th><th>Accent</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody id="person-rows"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody>
    </table>
  </div>
</section>
<section class="tab-panel" id="panel-stats" role="tabpanel" hidden>
  <dl class="stats-grid" id="stats-grid"><div class="muted">加载中…</div></dl>
</section>
<dialog id="user-dialog" class="dialog" aria-labelledby="user-dialog-title">
  <form id="user-form" method="dialog" novalidate>
    <h2 id="user-dialog-title">新建用户</h2>
    <label class="field"><span>角色</span>
      <select id="user-role" name="role">
        <option value="viewer">查看者</option>
        <option value="uploader">上传者</option>
        <option value="admin">管理员</option>
      </select>
    </label>
    <label class="field"><span>密码（留空自动生成）</span>
      <input id="user-password" name="password" type="text" minlength="8" maxlength="128" autocomplete="new-password" placeholder="至少 8 个字符">
    </label>
    <p id="user-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-user-dialog">取消</button>
      <button type="submit" class="button primary">创建</button>
    </div>
  </form>
</dialog>
<dialog id="password-dialog" class="dialog" aria-labelledby="password-dialog-title">
  <form id="password-form" method="dialog" novalidate>
    <h2 id="password-dialog-title">重置密码</h2>
    <p class="muted" id="password-target"></p>
    <label class="field"><span>新密码（留空自动生成）</span>
      <input id="password-value" name="password" type="text" minlength="8" maxlength="128" autocomplete="new-password">
    </label>
    <p id="password-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-password-dialog">取消</button>
      <button type="submit" class="button primary">重置</button>
    </div>
  </form>
</dialog>
<dialog id="person-dialog" class="dialog person-dialog" aria-labelledby="person-dialog-title">
  <form id="person-form" method="dialog" novalidate>
    <h2 id="person-dialog-title">添加人物</h2>
    <label class="field"><span>名字</span>
      <input id="person-name" name="name" type="text" maxlength="40" required placeholder="例如：Fried">
    </label>
    <label class="field"><span>头像（会居中裁剪为 200×200 AVIF）</span>
      <input id="person-avatar" name="avatar" type="file" accept="image/*">
    </label>
    <div class="person-avatar-preview" id="person-avatar-preview" hidden>
      <img id="person-avatar-image" alt="头像预览">
    </div>
    <div class="accent-picker">
      <div class="accent-preview" id="accent-preview" aria-hidden="true"></div>
      <label class="field accent-field"><span>色相 <output id="accent-hue-value">330</output></span>
        <input id="accent-hue" name="hue" type="range" min="0" max="360" step="1" value="330">
      </label>
      <label class="field accent-field"><span>饱和度 <output id="accent-saturation-value">70</output>%</span>
        <input id="accent-saturation" name="saturation" type="range" min="0" max="100" step="1" value="70">
      </label>
      <label class="field accent-field"><span>亮度 <output id="accent-lightness-value">80</output>%</span>
        <input id="accent-lightness" name="lightness" type="range" min="0" max="100" step="1" value="80">
      </label>
    </div>
    <p id="person-error" class="form-error" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-person-dialog">取消</button>
      <button type="submit" class="button primary">保存</button>
    </div>
  </form>
</dialog>
<dialog id="confirm-dialog" class="dialog" aria-labelledby="confirm-title">
  <form method="dialog">
    <h2 id="confirm-title">确认操作</h2>
    <p id="confirm-message"></p>
    <div class="dialog-actions">
      <button type="button" class="button ghost" data-action="close-confirm" autofocus>取消</button>
      <button type="button" class="button danger" id="confirm-ok">确认</button>
    </div>
  </form>
</dialog>`;
  return renderLayout({
    title: '管理台 · Kig Photo Space',
    body,
    role: options.role,
    authenticated: options.authenticated,
    active: 'admin',
    assets: options.manifest.entry('admin.ts'),
    bodyClass: 'admin-body',
  });
}
