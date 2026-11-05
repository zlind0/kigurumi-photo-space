# 安全设计

## 威胁模型

- 服务器可能被低权限攻击者访问，但不应能通过上传接口执行代码或耗尽内存。
- 持密码用户被视为可信：他们可以在浏览器内生成任意 AVIF 像素内容。
- 公众只能看公开内容；私密资源对未授权者返回 404，避免枚举。
- 服务器不做图片解码，减少攻击面。

## 认证

- 仅密码，无用户名。
- `password_lookup = HMAC-SHA256(AUTH_PEPPER, password)`，唯一索引，O(1) 查找。
- `password_hash = scrypt$N$r$p$salt$hash`，N=2^15、r=8、p=1、keylen=32。
- 查找未命中时执行一次 dummy scrypt，降低时序泄露。
- 密码长度 8–128；管理员生成密码 16 位 base64url。
- 登录失败统一返回“密码错误”，不区分用户不存在/密码错误。
- 登录限流：每 IP 10 次/分钟、100 次/小时；全局 100 次/分钟。
- 首次部署用 CLI 创建管理员，不提供公开的“首次设置”页面。

## 会话

- 32 字节随机 token（base64url），cookie 存明文，DB 存 SHA-256(token)。
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`；HTTPS 下 `Secure` + `__Host-` 前缀。
- 滑动 7 天，绝对上限 30 天；每小时最多更新一次 `last_seen_at`。
- 登录时删除旧 session（防 fixation）。
- 管理员重置密码/禁用用户时删除该用户所有 session。

## CSRF

- `SameSite=Lax` 为基础。
- 所有变更请求校验：
  - `Origin` 必须等于 `PUBLIC_ORIGIN`（或同 host）；
  - `Sec-Fetch-Site` 若存在必须是 `same-origin`；
  - 要求 `X-Requested-With: fetch`。
- 不满足返回 403 `CSRF`。

## XSS / SQL 注入 / 路径

- 所有 HTML 插值走 `escapeHtml`；客户端更新 DOM 用 `textContent`，不用 `innerHTML` 插入用户数据。
- SQL 全部 prepared statement。
- 相册目录由服务端生成；媒体路由文件名用正则白名单；`path.resolve` 后校验仍在相册目录内；拒绝符号链接。
- CSP：`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; frame-ancestors 'none'`。
- `style-src` 允许 `'unsafe-inline'` 仅用于错误页/登录页的内联样式；不用于脚本。

## 上传安全

- 只接受 AVIF；魔数 + 容器结构校验。
- 校验：`ftyp`/`avif` brand、`meta`、`pitm`、`iinf`、`iloc`、`iprp`、`ispe`、`av1C`、`pixi`、`mdat`、extent 边界、`construction_method`、尾随字节。
- 拒绝动画（`avis` brand）。
- 缩略图必须 600×600、8-bit、4:2:0、非单色。
- 全图 ≤ 50MB、≤ 12000px、≤ 80MP；缩略图 ≤ 2MB。
- 临时文件随机名、0600；启动时清理。
- 上传接口要求上传者+；CSRF；限流；并发限制。
- 服务端不执行任何图片解码器。
- 文件名由服务端 MD5 生成，不使用客户端文件名作为路径。
- 原始文件名只存 DB，展示时转义。

## 隐私与可见度

- 私密相册/照片对公众返回 404，不返回 403。
- 私密相册不出现在公众首页/API。
- `hidden/` 缩略图同样受保护。
- 公开相册封面必须是公开照片，避免封面泄露。
- `robots.txt` 默认 `Disallow: /`。
- 不记录“查看”行为；审计只记录登录、上传、建相册、删除、改可见度、用户管理。
- EXIF 可能含 GPS；公开照片的 EXIF 视为公开。v1 不自动剥离，管理台提示。

## HDR 与元数据

- HDR AVIF 原样上传时保留原始 EXIF/ICC/irot/imir。
- 重新编码时把原始 EXIF TIFF 注入 AVIF 容器，并把 Orientation 改为 1，避免二次旋转。
- 注入失败时上传不含 EXIF 的版本并提示，不静默丢 EXIF。
- 缩略图不写 EXIF，避免隐私和体积。
- 服务端只校验容器结构，不验证像素；客户端上传前会自己解码一次。

## 限流与配额

- 登录：见上。
- 上传：每 session 1 并发、全局 2 并发。
- 相册创建：每用户 200 个相册上限。
- 磁盘：`MAX_TOTAL_BYTES`、`MIN_FREE_BYTES`。
- 单相册照片数：默认 5000。
- 请求体：JSON 64KB；multipart 按路由限制。

## 审计日志

记录动作：

- `login.success` / `login.failure` / `logout`
- `album.create` / `album.delete` / `album.visibility`
- `photo.upload` / `photo.delete` / `photo.tier` / `photo.visibility`
- `user.create` / `user.update` / `user.delete` / `user.password_reset`

字段：时间、用户、session、IP、UA、目标类型/ID、详情 JSON。不记录密码、token、照片内容。保留 180 天。

## 安全头

```text
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains   # 仅 HTTPS
```

## 依赖与供应链

- 锁定 `pnpm-lock.yaml`；CI 跑 `pnpm audit`。
- wasm 自托管，不从 CDN 加载。
- 生产 `NODE_ENV=production`。
- 定期更新；升级前跑测试。
