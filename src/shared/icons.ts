/**
 * 相册照片操作按钮使用的小图标。
 * 服务端模板和客户端增量渲染共用同一份 SVG，避免两边样式漂移。
 * 线条图标默认 fill: none / stroke: currentColor，由 CSS 控制实心状态。
 */
export const ICON_STAR = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="icon-star" d="M12 2.6l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.66l-5.9 3.1 1.13-6.57L2.45 9.54l6.6-.96z"/></svg>`;

export const ICON_LOCK = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect class="icon-lock-body" x="4.9" y="10.4" width="14.2" height="9.6" rx="2.4"/><path class="icon-lock-shackle" d="M8.1 10.4V8a3.9 3.9 0 0 1 7.8 0v2.4"/></svg>`;

export const ICON_TRASH = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.8 7h14.4"/><path d="M9.8 4.6h4.4"/><path d="M6.6 7l.85 11.9a2 2 0 0 0 2 1.9h5.1a2 2 0 0 0 2-1.9L17.4 7"/><path d="M10.2 10.8v5.6"/><path d="M13.8 10.8v5.6"/></svg>`;

/** 顶部导航：上传（向上箭头）、设置（齿轮）、登录（人形）。 */
export const ICON_UPLOAD_ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5"/><path d="M5.8 11.2L12 5l6.2 6.2"/></svg>`;

export const ICON_GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

export const ICON_USER = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 21v-1.8a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 19.2V21"/><circle cx="12" cy="7.2" r="3.9"/></svg>`;

/** 照片查看器：信息、下载、关闭与左右翻页。 */
export const ICON_INFO = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.4"/><path d="M12 7.7h.01"/></svg>`;

export const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4.5v10"/><path d="M7.5 10.2L12 14.7l4.5-4.5"/><path d="M5 19.5h14"/></svg>`;

export const ICON_CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.2 6.2l11.6 11.6"/><path d="M17.8 6.2L6.2 17.8"/></svg>`;

export const ICON_CHEVRON_LEFT = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.6 5.4L8 12l6.6 6.6"/></svg>`;

export const ICON_CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.4 5.4L16 12l-6.6 6.6"/></svg>`;
