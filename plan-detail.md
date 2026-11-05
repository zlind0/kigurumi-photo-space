# Kig Photo Space — 详细实施计划

> 依据：`plan.md`
> 版本：v1.0（2026-11-06）
> 状态：待评审，评审通过后按第 13 节分阶段实施
> 目标：在低带宽、低性能服务器上，做一个“浏览器负责转码、服务器只存 AVIF + SQLite”的私密照片分享站。

---

## 0. 结论摘要

| 项目 | 决定 |
| --- | --- |
| 服务端 | Node.js 24 + Fastify 5 + 内置 `node:sqlite` |
| 前端 | TypeScript + Vite，无 UI 框架，服务端渲染 HTML + 少量原生 JS |
| 图片 | 只存 AVIF；全图 + 600×600 缩略图；服务端零编解码 |
| 转码 | 浏览器 Web Worker 内用 libavif wasm；HEIC 用 libheif wasm；EXIF 用容器重写方式保留 |
| 认证 | 仅密码登录；scrypt 哈希 + HMAC 查找键；服务端 session |
| 权限 | 公众 / 查看者 / 上传者 / 管理员，管理员继承上传者，上传者继承查看者 |
| 存储 | `data/<相册目录>/{cover.avif, cover.thumb.avif, top/, others/, hidden/}` |
| 元数据 | SQLite，WAL 模式，单文件，便于备份 |
| 缓存 | 内容哈希文件名 + `immutable` 长缓存；HTML 每次校验 |
| 部署 | 单 Node 进程 + systemd；Caddy 负责 TLS/HTTP2/压缩 |
| 最大风险 | 浏览器端大图编码内存、EXIF 注入的 AVIF 容器兼容性、HEIC 兼容性 |

**核心取舍：**

1. **服务器绝不解码/编码图片。** 服务端只做 AVIF 容器结构校验、MD5、文件搬运。
2. **信任持密码用户。** 上传者浏览器完成解码、缩放、编码、EXIF 保留；服务端做结构与配额校验，不做像素级验证。
3. **目录即权限。** `top/`、`others/` 是公开内容，`hidden/` 是登录后内容；媒体路由只查相册可见度，不逐张查照片，降低弱服务器压力。
4. **不保留原图。** 转码成功后只存 AVIF；EXIF 写入 AVIF 容器。若 EXIF 注入失败，按第 6.5 节降级并明确提示。
5. **首屏服务端渲染。** 首页/相册页的 HTML 直接带封面和精选，JS 只负责登录、灯箱、分页和操作，减少弱客户端与弱网络下的白屏。

---

## 1. 目标、范围与非目标

### 1.1 目标

- 公众无需密码浏览所有公开照片。
- 查看者登录后可看私密相册和公开相册中的私密照片。
- 上传者可在浏览器内把 JPEG/PNG/WebP/HEIC/AVIF 转成 AVIF，上传、建相册、管理本次 session 上传的照片档次，下载的时候，用户可以选择下载AVIF还是JPEG，下载JPEG的话，转码过程在浏览器中进行。
- 管理员可管理用户、密码、照片/相册可见度、删除照片/相册、查看操作日志。
- 在 1 核 / 512MB 内存 / 小带宽的服务器上稳定运行。
- 首页和相册页在慢速网络下仍然快速、可读、无布局跳动。

### 1.2 v1 范围

- 密码登录、角色、session、审计日志。
- 相册创建、列表、详情、封面、精选、其他、公开/私密。
- 照片上传、浏览器转码、缩略图、EXIF 保留、去重、删除。
- 管理员用户管理、日志、可见度管理。
- 响应式布局、灯箱、懒加载、分页。
- systemd/Caddy 部署文档、备份/恢复脚本。

### 1.3 非目标（v1 不做）

- 用户名/邮箱注册、找回密码、OAuth、Passkey。
- 相册重命名、拖拽排序、手动排序。
- 一张照片属于多个相册。
- 照片搜索、标签、人脸识别、地图。
- 评论、点赞、分享链接、下载统计。
- 视频、GIF、动画 AVIF/HEIC。
- 服务端图片处理（缩略图、格式转换、水印）。
- 多进程/多机部署、Redis、对象存储。
- Service Worker 离线缓存（可作为 v2）。
- 英文 UI（先中文，字符串集中管理，便于以后加）。

---

## 2. 设计原则

1. **弱服务器优先**：任何请求路径都要问“这会不会让服务器做图片工作？”答案必须是否。
2. **带宽优先**：列表只加载 600×600 缩略图；全图只在灯箱按需加载；不加载 Web Font。
3. **缓存优先**：照片文件名是内容 MD5，URL 永久可缓存；封面 URL 带版本参数。
4. **目录即状态**：照片的公开/私密、精选/其他由所在目录表达，媒体路由不需要查照片表。
5. **失败可恢复**：上传先写临时文件，校验通过再原子 rename；删除进回收站；数据库可备份。
6. **权限默认拒绝**：未登录只能看公开；私密资源返回 404 而不是 403，避免枚举。
7. **渐进增强**：核心内容服务端渲染；JS 失效时仍能看照片，登录/上传等交互才依赖 JS。
8. **可观测**：关键操作写审计日志；错误日志不含密码/token；健康检查覆盖 DB 和数据目录。

---

## 3. 技术选型

| 层 | 选择 | 理由 | 备选/备注 |
| --- | --- | --- | --- |
| Runtime | Node.js 24 LTS | 环境已有；内置 `node:sqlite`、`crypto.scrypt`、`fs.statfs` | 不用 Bun，减少不确定性 |
| HTTP | Fastify 5 | 轻量、流式、插件成熟、低开销 | 不用 Express（中间件开销更大） |
| DB | `node:sqlite`（内置） | 零原生依赖，部署简单；同步 API 对弱服务器足够快 | 若遇 API 限制，可换 `better-sqlite3`，接口相近 |
| 服务端语言 | TypeScript，`tsc` 编译到 `dist/server` | 类型安全；不引入运行时转译 | 生产不跑 `tsx` |
| 前端构建 | Vite + TypeScript | 代码分割、worker、wasm 资源处理成熟 | 不用 React/Vue，减少 JS 体积 |
| 前端框架 | 无（原生 DOM + 模板字符串） | 页面简单；首屏由服务端渲染 | 复杂交互用小型模块封装 |
| HTML | 服务端模板字符串 + `escapeHtml` | 零模板引擎依赖；首屏快 | 不引入 EJS/Eta |
| CSS | 原生 CSS，CSS 变量，Grid/Flex | 体积小；无构建依赖 | 不用 Tailwind |
| AVIF 编解码 | `@phenomen/libavif-wasm` | ESM、浏览器/Worker 友好、支持 8-bit 4:2:0、decode+encode | 备选 `@jsquash/avif` |
| HEIC 解码 | `heic-decode`（libheif-js） | 浏览器内解码 HEIC 到 RGBA | 仅在上传页按需加载 |
| EXIF 读取 | `exifr` | 支持 JPEG/PNG/WebP/HEIC/AVIF，体积小 | 只读；写入用自研容器重写 |
| MD5 | `hash-wasm` | wasm 实现，大文件比纯 JS 快 | 不用 SubtleCrypto（无 MD5） |
| 测试 | Vitest + Fastify inject + Playwright | 单元/集成/E2E 覆盖 | E2E 可选跑 |
| 部署 | systemd + Caddy | 单进程、TLS、HTTP/2、压缩 | Docker 可选，不作为默认 |

### 3.1 为什么服务端用 `node:sqlite`

- 无原生编译，弱服务器/容器部署不会卡在 `better-sqlite3` 编译。
- 同步 API 简单，单进程下没有并发写竞争。
- 支持 WAL、prepared statement、`backup()`。
- 数据量小（相册/照片元数据），性能足够。

### 3.2 为什么前端不用框架

- 首页/相册页由服务端渲染，JS 只做增强。
- 上传页的复杂度在 wasm/Worker，不在 UI 框架。
- 目标 JS 体积：`app.js` < 15KB gzip，`admin.js` < 15KB gzip，上传逻辑按需加载。

---

## 4. 角色与权限

### 4.1 角色定义

| 角色 | 获得方式 | 说明 |
| --- | --- | --- |
| 公众 `public` | 无 session | 只能看公开相册中的公开照片 |
| 查看者 `viewer` | 密码登录 | 可看公开 + 私密相册/照片 |
| 上传者 `uploader` | 管理员分配 | 继承查看者；可建相册、上传、管理本次 session 上传的照片 |
| 管理员 `admin` | 管理员分配 | 继承上传者；可管理用户、删除任意照片/相册、改可见度、看日志 |

> 管理员不是“另一个体系”，而是上传者的超集。这样减少权限分支。

### 4.2 权限矩阵

| 操作 | 公众 | 查看者 | 上传者 | 管理员 |
| --- | :---: | :---: | :---: | :---: |
| 看公开相册/照片 | ✅ | ✅ | ✅ | ✅ |
| 看私密相册/照片 | ❌ | ✅ | ✅ | ✅ |
| 登录/登出 | ✅ | ✅ | ✅ | ✅ |
| 新建相册 | ❌ | ❌ | ✅ | ✅ |
| 上传照片到任意可见相册 | ❌ | ❌ | ✅ | ✅ |
| 删除本次 session 自己上传的照片 | ❌ | ❌ | ✅ | ✅ |
| 设置本次 session 自己上传照片的档次/封面 | ❌ | ❌ | ✅ | ✅ |
| 删除任意照片 | ❌ | ❌ | ❌ | ✅ |
| 修改照片可见度 | ❌ | ❌ | ❌ | ✅ |
| 修改相册可见度 | ❌ | ❌ | ❌ | ✅ |
| 删除相册 | ❌ | ❌ | ❌ | ✅ |
| 新建/删除用户、分配密码 | ❌ | ❌ | ❌ | ✅ |
| 查看操作日志 | ❌ | ❌ | ❌ | ✅ |

### 4.3 关键权限规则

1. **“本次 session”**：照片记录 `upload_session_id`。上传者只能删除/改档次 `upload_session_id === 当前 session.id` 的照片。重新登录后，旧照片不再可管理（管理员可以）。
2. **照片不归属于用户**：`uploaded_by` 只用于审计和“本次上传”展示，不构成所有权；用户删除后照片保留。
3. **封面权限**：上传者可以把“本次 session 自己上传的照片”设为所在相册的封面；这会改变相册封面。管理员可设任意照片为封面。
4. **可见度权限**：只有管理员能改照片/相册的公开/私密。
5. **最后一个管理员**：不能删除、降级或禁用最后一个启用状态的管理员。
6. **私密资源**：未授权一律 404，不返回 403，避免泄露“存在但无权”。
7. **封面与公开相册**：公开相册的封面照片必须是公开照片；否则拒绝设置/拒绝把相册改为公开。

---

## 5. 数据模型

### 5.1 SQLite schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -4000;      -- 约 4MB
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'uploader', 'viewer')),
  password_lookup TEXT NOT NULL UNIQUE,   -- HMAC-SHA256(pepper, password) hex
  password_hash   TEXT NOT NULL,          -- scrypt$N$r$p$salt$hash
  created_at      INTEGER NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_login_at   INTEGER,
  disabled        INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,         -- SHA-256(token) hex，不存明文 token
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,              -- 展示名
  dir_name    TEXT NOT NULL,              -- 文件系统目录名（保留 Unicode）
  dir_key     TEXT NOT NULL UNIQUE,       -- 规范化小写，防大小写冲突
  visibility  TEXT NOT NULL DEFAULT 'public'
              CHECK (visibility IN ('public', 'private')),
  created_at  INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_albums_created ON albums(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_albums_visibility ON albums(visibility, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS photos (
  id                INTEGER PRIMARY KEY,
  album_id          INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  md5               TEXT NOT NULL,        -- 全图 AVIF 内容 MD5
  thumb_md5         TEXT NOT NULL,        -- 缩略图 AVIF 内容 MD5
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  size_bytes        INTEGER NOT NULL,
  thumb_size_bytes  INTEGER NOT NULL,
  tier              TEXT NOT NULL DEFAULT 'other'
                    CHECK (tier IN ('cover', 'featured', 'other')),
  visibility        TEXT NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public', 'private')),
  original_name     TEXT,
  mime              TEXT NOT NULL DEFAULT 'image/avif',
  exif_json         TEXT,                 -- 客户端提取的摘要，可选
  created_at        INTEGER NOT NULL,
  uploaded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  upload_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  deleted_at        INTEGER,
  UNIQUE (album_id, md5)
);
CREATE INDEX IF NOT EXISTS idx_photos_album_created
  ON photos(album_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_album_vis_tier
  ON photos(album_id, visibility, tier, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_md5 ON photos(md5);
CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(upload_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_one_cover
  ON photos(album_id) WHERE tier = 'cover' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id  TEXT,
  action      TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT                        -- JSON 字符串
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts DESC);
```

### 5.2 表说明与约束

- `users.password_lookup` 唯一：密码即身份，两个用户不能有相同密码。管理员创建用户时若密码重复，返回 409。
- `sessions.id` 存 token 的 SHA-256，不存明文；cookie 里才是明文 token。
- `albums.dir_key` 用 `name.normalize('NFC').toLocaleLowerCase('und')` 生成，避免 macOS/Windows 大小写不敏感文件系统冲突。
- `photos` 的 `UNIQUE(album_id, md5)` 保证同一相册内去重；跨相册可硬链接复用文件。
- `idx_photos_one_cover` 保证一个相册最多一张 `tier='cover'`。
- `deleted_at` 预留给软删除；v1 照片删除直接删行+文件，相册删除进回收站。保留字段便于以后做恢复。
- 时间统一存 Unix 毫秒（UTC），前端按浏览器时区显示。

### 5.3 文件系统布局

```text
data/
  db.sqlite
  db.sqlite-wal
  db.sqlite-shm
  .secret                     # 开发环境自动生成的 pepper，生产用环境变量
  tmp/                        # 上传临时文件，启动时清理
  .trash/                     # 删除的相册，按时间戳命名
  <album-dir>/
    cover.avif                # 封面全图（硬链接到 top/ 或 hidden/ 中的照片）
    cover.thumb.avif          # 封面缩略图（硬链接）
    top/                      # 公开 + 精选
      <md5>.avif
      <md5>.thumb.avif
    others/                   # 公开 + 其他
      <md5>.avif
      <md5>.thumb.avif
    hidden/                   # 私密照片（查看者及以上可见）
      <md5>.avif
      <md5>.thumb.avif
```

说明：

- `cover.avif` 是硬链接（同文件系统），不是副本；跨文件系统或硬链接失败时退化为复制。
- 缩略图与全图同目录，权限跟随目录，避免单独的 `thumbs/` 目录泄露私密缩略图。
- 文件名严格为 32 位小写十六进制 MD5 + `.avif` / `.thumb.avif`。
- 相册目录名由服务端生成，客户端永远不能传路径。

### 5.4 可见度 / 档次 / 目录映射

| 照片可见度 | 档次 | 所在目录 | 公开可见 | 查看者可见 |
| --- | --- | --- | :---: | :---: |
| public | featured | `top/` | ✅ | ✅ |
| public | other | `others/` | ✅ | ✅ |
| public | cover | `top/`（封面文件在根） | ✅ | ✅ |
| private | featured | `hidden/` | ❌ | ✅ |
| private | other | `hidden/` | ❌ | ✅ |
| private | cover | `hidden/`（封面文件在根） | ❌ | ✅ |

- 相册 `visibility='private'` 时，整个相册对公众不可见；目录仍按照片可见度存放，媒体路由先查相册。
- 相册从私密改公开时，不需要移动文件；但封面必须是公开照片，否则拒绝。
- 照片从公开改私密时，文件从 `top/`/`others/` 移到 `hidden/`；反之移回。
- 照片从 `other` 改 `featured` 时，文件在 `others/` 与 `top/` 之间移动；私密照片只在 `hidden/` 内，档次只改 DB。
- 移动文件用 `rename`（同文件系统原子），并同步更新封面硬链接。

### 5.5 封面规则

1. 每个相册最多一张 `tier='cover'`。
2. 新相册第一张上传成功的照片自动成为封面；之后上传默认 `other`。
3. 设置新封面时：
   - 旧封面降级为 `featured`（如果旧封面就是当前照片则不变）。
   - 新封面照片的 `tier` 改为 `cover`。
   - 更新 `cover.avif` / `cover.thumb.avif` 硬链接（临时链接 + rename，保证原子）。
4. 删除封面照片时：
   - 优先提升最早的 `featured` 照片为封面；
   - 否则提升最早的 `other` 照片；
   - 都没有则删除 `cover.avif` / `cover.thumb.avif`，首页显示占位。
5. 公开相册的封面必须是公开照片；私密相册的封面可以是私密照片。
6. 封面 URL 带 `?v=<cover_md5>`，封面变化时 URL 变化，浏览器缓存自然失效。

### 5.6 去重规则

- **相册内去重**：`UNIQUE(album_id, md5)`。重复上传同一内容，返回已有照片，不新增行。
- **跨相册复用**：上传时若全局已有相同 `md5`，优先 `fs.link` 到目标路径；失败则 `fs.copyFile`。删除时只 unlink 当前相册的链接，不影响其他相册。
- **缩略图**：按 `thumb_md5` 命名；同一相册内若缩略图内容相同，可共用文件（覆盖写入相同内容无副作用）。
- **MD5 由服务端重新计算**：客户端传来的 MD5 只用于 UI 预判，服务端以自己计算的为准。

### 5.7 删除与回收站

- **照片删除**：删除 DB 行 + unlink 全图/缩略图；若是封面，先按 5.5 提升新封面。硬链接的其他相册不受影响。
- **相册删除**：`rename(data/<dir>, data/.trash/<timestamp>-<dir>)`，然后删除 DB 行（级联照片）。审计日志保留。
- **回收站清理**：每日任务删除 `.trash/` 中超过 `TRASH_RETENTION_DAYS`（默认 7 天）的目录。
- **孤儿文件**：提供 `scripts/fsck.ts`，扫描 `data/` 中不在 DB 的文件和 DB 中不存在的文件，默认只报告，`--fix` 才删除孤儿文件。

### 5.8 相册命名

- 展示名 `name`：1–80 字符，去首尾空白，禁止控制字符。
- 目录名 `dir_name`：
  - Unicode NFC 规范化；
  - 去掉 `/`、`\`、`..`、首尾点/空格、控制字符；
  - 保留中文、字母、数字、空格、`-`、`_`；
  - 最长 80 字符；
  - 保留名（`tmp`、`.trash`、`cover`、`top`、`others`、`hidden`、`db.sqlite` 等）加 `_` 前缀；
  - 空则拒绝。
- `dir_key = dir_name.normalize('NFC').toLocaleLowerCase('und')`，唯一。重复返回 409。
- v1 不支持重命名；需要改名时删除重建（管理员操作，有确认）。

### 5.9 迁移策略

- 启动时读取 `src/server/db/migrations/*.sql`，按文件名排序，在事务中执行未应用的版本。
- 迁移前自动 `backup()` 到 `data/backups/pre-migrate-<version>.sqlite`。
- 迁移失败则回滚事务并拒绝启动，避免半迁移状态。

---

## 6. 上传与转码流水线

### 6.1 支持格式

| 输入 | 检测方式 | 全图处理 | 缩略图 | 备注 |
| --- | --- | --- | --- | --- |
| AVIF | `ftyp` + `avif` brand | **不转码**，原样上传 | 浏览器/wasm 解码后生成 | 保留原 EXIF/ICC/irot/imir |
| HEIC/HEIF | `ftyp` + `heic/heix/mif1/msf1` | libheif 解码 → 8-bit 4:2:0 AVIF | 同左 | 仅静态图；HDR 转 SDR |
| JPEG | `FF D8 FF` | 浏览器解码 → 8-bit 4:2:0 AVIF | 同左 | 应用 EXIF 方向 |
| PNG | PNG magic | 浏览器解码 → 8-bit 4:2:0 AVIF | 同左 | 保留 alpha（如支持） |
| WebP | `RIFF....WEBP` | 浏览器解码 → 8-bit 4:2:0 AVIF | 同左 | 静态图 |
| GIF/TIFF/BMP | — | 拒绝 | — | 提示先转 JPEG/PNG |

> “如果上传的图片已经是 AVIF，则不转码”指**全图不重新编码**；缩略图仍必须生成，因为原图可能没有 600×600 缩略图。

### 6.2 客户端流程

```text
选择文件
  → 魔数检测格式
  → 读取 EXIF（exifr）+ 原始 EXIF TIFF 段
  → 解码为 ImageBitmap / ImageData（Worker 内）
  → 应用方向（EXIF Orientation / AVIF irot+imir）
  → 全图：等比缩放到最大边 MAX_IMAGE_DIMENSION（默认 6000）
      → 若输入不是 AVIF：libavif 编码 8-bit 4:2:0
      → 若输入是 AVIF：保留原字节
  → 缩略图：居中裁剪为正方形 → 缩放到 600×600 → libavif 编码
  → 若全图被重新编码：把原始 EXIF TIFF 注入 AVIF 容器（方向改为 1）
  → 计算全图/缩略图 MD5
  → multipart 上传（XHR，显示字节进度）
  → 服务端校验、去重、落盘、写 DB
```

### 6.3 编码参数

| 参数 | 全图 | 缩略图 |
| --- | --- | --- |
| 格式 | AVIF | AVIF |
| 位深 | 8-bit | 8-bit |
| 色度采样 | 4:2:0 | 4:2:0 |
| 质量 | 60（可配置 50–70） | 50 |
| 速度 | 8（0 最慢，10 最快） | 8 |
| 最大边 | 10000px（可配置） | 600×600 |
| 最大像素 | 100MP | 0.36MP |
| 元数据 | 保留 EXIF；色彩转 sRGB | 不写 EXIF |
| alpha | 保留（若源有） | 保留（若源有） |

- 全图质量 60 是“照片分享”折中；若用户反馈细节不足，可提高到 65，但文件会变大。
- 缩略图必须严格 600×600，居中裁剪；服务端会校验 `ispe`。
- 不使用多线程 wasm，避免 COOP/COEP 和 SharedArrayBuffer 复杂度；单线程编码在 Worker 中不阻塞 UI。

### 6.4 缩略图生成

- 居中裁剪：取原图中心的最大正方形，再缩放到 600×600。
- 使用 `createImageBitmap` 的 `resizeWidth`/`resizeHeight` 先降采样，减少内存；再在 `OffscreenCanvas` 上裁剪。
- 对 AVIF 输入：优先浏览器 `createImageBitmap`（支持 AVIF 的浏览器），失败则用 libavif wasm 解码。
- 对 HEIC：`heic-decode` 解码到 RGBA；大图先检查像素数，超过限制直接拒绝并提示。
- 缩略图不写 EXIF，避免隐私和体积。

### 6.5 EXIF、方向与色彩

**目标：** 转码后 EXIF 不丢；方向正确；颜色不偏。

1. **读取**：`exifr` 读取摘要（相机、镜头、拍摄时间、GPS、方向）用于 UI/DB；同时提取原始 EXIF TIFF 段：
   - JPEG：APP1 `Exif\0\0` 后的 TIFF；
   - PNG：`eXIf` chunk；
   - WebP：`EXIF` chunk；
   - HEIC/AVIF：ISOBMFF `Exif` item，跳过 4 字节 TIFF 偏移。
2. **方向**：
   - JPEG/PNG/WebP：`createImageBitmap(..., { imageOrientation: 'from-image' })` 应用 EXIF 方向。
   - HEIC：用 `exifr` 的 Orientation 手动旋转 canvas。
   - AVIF：解析 `irot`/`imir` 属性并应用；AVIF 输入不转码时保留原属性。
   - 转码后的像素已摆正，注入 EXIF 时把 Orientation 标签改为 1，避免二次旋转。
3. **色彩**：canvas 绘制会把源颜色转换到 sRGB；libavif 编码标记 sRGB。v1 不保留源 ICC（会丢失广色域），在 UI 中不承诺 ICC 保留。
4. **EXIF 注入**：
   - 使用共享的 AVIF 容器重写模块：读取所有 item（主图、alpha、XMP、ICC、Exif），重建 `meta`/`iloc`/`iref`/`mdat`，加入 `Exif` item，并建立 `cdsc` 引用到主图 item。
   - 参考 `aeo-image`（MIT）的 ISOBMFF 重写思路，自己实现并加测试；只搬运字节，不重编码。
   - 注入后客户端用 libavif 解码一次，确认图片仍可打开；失败则回退。
5. **降级**：
   - 若 AVIF 容器使用不支持的构造方式（如 `construction_method=2`），先尝试 ExifTool wasm（按需加载，体积大，仅失败时用）。
   - 仍失败则拒绝该文件并提示“该文件容器结构暂不支持保留 EXIF，请先转成 JPEG 再上传”。不静默丢 EXIF。
6. **隐私提示**：EXIF 可能含 GPS。公开照片的 EXIF 对公众可见（如果以后做 EXIF 展示/下载）。v1 在管理台提示，不默认剥离。

### 6.6 进度、并发与内存

- **Worker**：编码/解码全部在 Web Worker；主线程只更新 UI。
- **并发**：编码并发 1（低端设备）或 2（`navigator.hardwareConcurrency >= 8`）；上传并发 2。
- **进度**：
  - 编码阶段是“阶段进度”（检测 → 解码 → 缩放 → 编码全图 → 编码缩略图 → 元数据），libavif 不提供字节级回调；
  - 上传阶段用 XHR `upload.onprogress` 显示字节进度；
  - 总体进度 = 已完成文件数 / 总数，加上当前文件阶段。
- **内存**：
  - 单文件输入上限 100MB；解码后像素上限 80MP；
  - 大图用 `createImageBitmap` 的 resize 参数直接降采样，避免完整 RGBA 常驻；
  - 编码完成立即释放 `ImageData`/`ImageBitmap`；
  - 队列一次只保留 1–2 个文件的中间数据。
- **取消/重试**：每个文件可取消（AbortController + Worker 终止）；失败可重试（重新编码）。

### 6.7 服务端接收与校验

**接收：**

- `POST /api/albums/:id/photos`，`multipart/form-data`：
  - `full`：AVIF 全图；
  - `thumb`：AVIF 缩略图；
  - `meta`：JSON 字符串（`originalName`、`width`、`height`、`md5`、`thumbMd5`、`exifSummary`）。
- 流式写入 `data/tmp/<random>.part`，同时计算 MD5；不把整个文件读进内存。
- 限制：`full` ≤ 50MB，`thumb` ≤ 2MB，字段 ≤ 64KB，文件数 = 2。
- 上传并发：全局 2，单 session 1；超出返回 429/503。

**校验（服务端零解码）：**

1. 文件大小、MD5 与文件名规则。
2. AVIF 容器结构：
   - `ftyp` 存在，brand 含 `avif`；拒绝 `avis`（动画）。
   - `meta` 存在，含 `pitm`、`iinf`、`iloc`、`iprp`。
   - 主 item 为 `av01` 或 `grid`；`grid` 的 tile 引用完整。
   - `ispe` 宽高 > 0，且在 `MAX_IMAGE_DIMENSION` / `MAX_IMAGE_PIXELS` 内。
   - `av1C` 存在且字段合法；`pixi` 若存在，位深与 `av1C` 一致。
   - `iloc` 的 extent 全部落在文件内；`data_reference_index=0`；拒绝 `construction_method=2`。
   - `mdat` 存在且非空；顶层 box 覆盖整个文件，无尾随垃圾。
   - `Exif`/XMP item 大小 ≤ 1MB。
3. 缩略图额外：
   - `ispe` 必须 600×600；
   - `av1C` 必须 8-bit、4:2:0、非 monochrome；
   - `pixi` 若存在必须 8-bit；
   - 文件 ≤ 2MB。
4. 全图额外：
   - 宽高 ≤ 12000，像素 ≤ 80MP；
   - 文件 ≤ 50MB；
   - 允许 alpha、grid、irot/imir；拒绝动画。
5. 服务端不验证“像素是否能正确解码”，只验证容器结构。这是“信任持密码用户”的明确边界；客户端在上传前会自己解码一次。

**校验实现：**

- 共享 `src/shared/avif/parse.ts`，客户端和服务端共用。
- 服务端用 `fs.open` + 随机读，只读 box 头和 `meta`，不读 `mdat` 像素；内存占用与文件大小无关。
- 缩略图 ≤ 2MB，可直接读入 Buffer 解析。

### 6.8 存储与去重

1. 校验通过后，根据照片可见度/档次决定目标目录：
   - 新上传默认 `visibility='public'`、`tier='other'`；
   - 若相册还没有封面，第一张自动 `tier='cover'`。
2. 目标路径：`data/<dir>/<tierDir>/<md5>.avif` 和 `<md5>.thumb.avif`。
3. 若 DB 已有同 `album_id + md5`：删除临时文件，返回已有照片（`deduped: true`）。
4. 若全局有同 `md5`：尝试 `fs.link` 复用；失败则 `fs.copyFile`。
5. `fs.rename(tmp, target)` 原子落盘；若目标已存在，先 unlink 临时文件。
6. 若是封面，更新 `cover.avif` / `cover.thumb.avif` 硬链接。
7. 写 DB（事务）；失败则删除刚创建的文件链接。
8. 写审计日志 `photo.upload`。

### 6.9 失败处理

| 失败点 | 处理 |
| --- | --- |
| 客户端解码失败 | 标记该文件失败，提示格式/损坏，不影响队列其他文件 |
| 客户端编码失败 | 提示“浏览器编码失败”，建议换浏览器或先转 JPEG |
| EXIF 注入失败 | 按 6.5 降级；不静默丢 |
| 上传中断 | 临时文件清理；UI 可重试 |
| 服务端校验失败 | 422 + 具体原因；删除临时文件 |
| 磁盘不足 | 507；删除临时文件；提示管理员 |
| DB 写失败 | 删除刚落的文件；500；记录日志 |
| 重复上传 | 200 + 已有照片；不报错 |

### 6.10 安全边界

- 服务端只接受 AVIF；不执行、不解析像素、不调用外部转换器。
- 临时文件随机名、0600；启动时清理 `data/tmp`。
- 所有路径由服务端拼接，客户端不能传目录/文件名。
- 上传接口要求登录 + 上传者及以上 + CSRF/Origin 校验。
- 单用户/单 IP 上传限流；磁盘配额；单相册照片数上限（默认 5000）。

---

## 7. API 设计

### 7.1 通用约定

- 前缀 `/api`；JSON 请求/响应；`Content-Type: application/json`。
- 认证：HttpOnly cookie `sid`（HTTPS 下 `__Host-sid`）。
- 变更请求必须同源：校验 `Origin`/`Sec-Fetch-Site`，并要求 `X-Requested-With: fetch`（或 `Content-Type: application/json`）。
- 错误格式：

```json
{
  "error": {
    "code": "INVALID_AVIF",
    "message": "缩略图必须是 600×600 的 8-bit 4:2:0 AVIF"
  }
}
```

- 时间：Unix 毫秒。
- 分页：cursor 为 base64url(`${createdAt}:${id}`)，`limit` 默认 50，最大 100。
- 所有 SQL 使用 prepared statement；所有用户输入在 HTML 中转义。

### 7.2 认证

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` | 公开 | `{ password }`；成功 Set-Cookie；失败 401；限流 429 |
| POST | `/api/logout` | 登录 | 删除当前 session，清 cookie |
| GET | `/api/me` | 公开 | 返回当前角色/session 信息 |

`GET /api/me` 响应：

```json
{
  "authenticated": true,
  "user": { "id": 2, "role": "uploader" },
  "session": { "expiresAt": 1760000000000 }
}
```

### 7.3 相册

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/albums?cursor=&limit=` | 公开 | 当前角色可见的相册，倒序 |
| POST | `/api/albums` | 上传者+ | `{ name }`；创建目录 + DB |
| GET | `/api/albums/:id` | 可见 | 相册详情 + 封面 + 精选 + 第一页全部照片 |
| PATCH | `/api/albums/:id` | 管理员 | `{ visibility }` |
| DELETE | `/api/albums/:id` | 管理员 | 移入回收站 + 删 DB |

`GET /api/albums` 响应：

```json
{
  "albums": [
    {
      "id": 3,
      "name": "2026 春",
      "dir": "2026-春",
      "visibility": "public",
      "createdAt": 1760000000000,
      "photoCount": 12,
      "cover": {
        "photoId": 42,
        "thumbUrl": "/m/2026-%E6%98%A5/cover.thumb.avif?v=abc123",
        "fullUrl": "/m/2026-%E6%98%A5/cover.avif?v=abc123",
        "width": 600,
        "height": 600
      },
      "canUpload": true,
      "canManage": false
    }
  ],
  "nextCursor": null
}
```

`GET /api/albums/:id` 响应：

```json
{
  "album": { "...": "同上" },
  "cover": "PhotoDTO | null",
  "featured": ["PhotoDTO"],
  "photos": { "items": ["PhotoDTO"], "nextCursor": "..." },
  "permissions": {
    "canUpload": true,
    "canCreateAlbum": true,
    "canManageAlbum": false,
    "canSetTier": true,
    "canSetVisibility": false
  }
}
```

> `photoCount`、`featured`、`photos.items` 都按当前角色过滤：公众只看到公开照片，查看者及以上看到全部。

`PhotoDTO`：

```json
{
  "id": 42,
  "albumId": 3,
  "md5": "d41d8cd98f00b204e9800998ecf8427e",
  "width": 4000,
  "height": 3000,
  "tier": "featured",
  "visibility": "public",
  "createdAt": 1760000000000,
  "originalName": "IMG_0001.HEIC",
  "thumbUrl": "/m/2026-%E6%98%A5/top/d41d...thumb.avif",
  "fullUrl": "/m/2026-%E6%98%A5/top/d41d....avif",
  "canDelete": true,
  "canSetTier": true,
  "canSetVisibility": false
}
```

### 7.4 照片

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/albums/:id/photos?cursor=&limit=` | 可见 | 分页全部可见照片 |
| POST | `/api/albums/:id/photos` | 上传者+ | multipart 上传 |
| PATCH | `/api/photos/:id` | 见规则 | `{ tier?, visibility? }` |
| DELETE | `/api/photos/:id` | 见规则 | 删除照片 |

`POST /api/albums/:id/photos` 响应：

```json
{
  "photo": "PhotoDTO",
  "deduped": false
}
```

- 新照片 201；重复照片 200 + `deduped: true`。
- 服务端返回的 `width`/`height` 来自 AVIF `ispe`，不信任客户端。

`PATCH /api/photos/:id` 响应：`{ "photo": "PhotoDTO" }`。
`DELETE /api/photos/:id` 响应：204。

`PATCH /api/photos/:id` 权限：

- `tier`：管理员，或上传者且 `upload_session_id === 当前 session`。
- `visibility`：仅管理员。
- 设置 `tier='cover'` 时，若相册公开且照片私密 → 409 `COVER_MUST_BE_PUBLIC`。
- 把封面照片改为私密且相册公开 → 409 `COVER_MUST_BE_PUBLIC`。

`DELETE /api/photos/:id` 权限：

- 管理员，或上传者且 `upload_session_id === 当前 session`。

### 7.5 管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | 管理员 | 用户列表 |
| POST | `/api/admin/users` | 管理员 | `{ role, password? }`；不传密码则生成并只返回一次 |
| PATCH | `/api/admin/users/:id` | 管理员 | `{ role?, password?, disabled? }` |
| DELETE | `/api/admin/users/:id` | 管理员 | 删除用户；保护最后一个管理员 |
| GET | `/api/admin/logs?cursor=&limit=&action=&userId=&from=&to=` | 管理员 | 审计日志 |
| GET | `/api/admin/stats` | 管理员 | 相册/照片/用户数、磁盘占用/剩余 |

### 7.6 媒体

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET/HEAD | `/m/:albumDir/cover.avif` | 相册可见 | 封面全图 |
| GET/HEAD | `/m/:albumDir/cover.thumb.avif` | 相册可见 | 封面缩略图 |
| GET/HEAD | `/m/:albumDir/:tier/:file` | 见规则 | `tier ∈ top/others/hidden`；`file` 匹配 `^[a-f0-9]{32}(\.thumb)?\.avif$` |

媒体路由鉴权（不查照片表）：

1. 按 `albumDir` 查相册（内存缓存 + DB）。
2. 相册不存在/已删除 → 404。
3. 相册 `private` 且角色为公众 → 404。
4. `tier='hidden'` 且角色为公众 → 404。
5. 封面：若相册公开，封面照片必须是公开（由写入规则保证）；否则 404。
6. 文件不存在 → 404。

缓存头：

- 公开内容：`Cache-Control: public, max-age=31536000, immutable`
- 私密内容：`Cache-Control: private, max-age=31536000, immutable`
- `ETag: "<md5>"`；支持 `If-None-Match` → 304。
- `Content-Type: image/avif`；`X-Content-Type-Options: nosniff`。
- 封面 URL 带 `?v=<cover_md5>`，服务端忽略 query，仅用于缓存失效。

### 7.7 错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数缺失/格式错误 |
| 401 | `AUTH_REQUIRED` | 未登录 |
| 401 | `INVALID_PASSWORD` | 密码错误（统一提示） |
| 403 | `FORBIDDEN` | 已登录但无权限 |
| 403 | `CSRF` | Origin/请求头校验失败 |
| 404 | `NOT_FOUND` | 资源不存在或无权查看 |
| 409 | `ALBUM_NAME_TAKEN` | 相册名/目录冲突 |
| 409 | `COVER_MUST_BE_PUBLIC` | 公开相册封面必须公开 |
| 409 | `LAST_ADMIN` | 不能删除/降级最后一个管理员 |
| 413 | `FILE_TOO_LARGE` | 超过大小限制 |
| 415 | `UNSUPPORTED_FORMAT` | 非 AVIF 或动画 |
| 422 | `INVALID_AVIF` | AVIF 容器结构不合法 |
| 422 | `INVALID_THUMBNAIL` | 缩略图不是 600×600/8-bit/4:2:0 |
| 429 | `RATE_LIMITED` | 登录/上传限流 |
| 507 | `QUOTA_EXCEEDED` | 磁盘/配额不足 |
| 500 | `INTERNAL` | 未预期错误 |

### 7.8 页面路由

| 路径 | 说明 |
| --- | --- |
| `/` | 首页相册陈列 |
| `/a/:albumDir` | 相册详情 |
| `/upload` | 上传页（上传者+） |
| `/admin` | 管理台（管理员） |
| `/login` | 无 JS 兜底登录页（可选） |
| `/healthz` | 健康检查 |
| `/robots.txt` | 默认 `Disallow: /`，可配置 |

---

## 8. 页面与交互

### 8.1 信息架构

```text
首页 /
  ├─ 登录弹窗
  ├─ 相册卡片 → /a/:dir
  └─ 新建相册卡片（上传者+）

相册页 /a/:dir
  ├─ 封面大图
  ├─ 精选网格
  ├─ 分割线
  ├─ 全部照片网格（分页/无限滚动）
  ├─ 灯箱
  └─ 照片操作（本次上传/管理员）

上传页 /upload
  ├─ 相册选择/新建
  ├─ 拖拽/选择文件
  ├─ 队列与进度
  └─ 本次上传结果与档次操作

管理台 /admin
  ├─ 操作日志
  ├─ 用户管理
  └─ 站点统计
```

### 8.2 首页

- 顶部：站点名、登录按钮/角色菜单、上传入口（上传者+）、日志/用户管理（管理员）。
- 相册网格：
  - 每张卡片最大 350×350，内部缩略图 300×300；
  - 卡片有轻微“相册装帧”装饰（CSS 边框/阴影/叠层），看起来有一堆照片，不使用图片；
  - 显示相册名、照片数、私密徽标（查看者可见）；
  - 倒序：`created_at DESC, id DESC`。
- 图片：
  - 第一张封面 `fetchpriority="high"`，不加 `loading="lazy"`；
  - 其余 `loading="lazy" decoding="async"`；
  - 明确 `width="600" height="600"`，CSS `aspect-ratio: 1`，避免 CLS。
- 上传者+：网格最后一张“+ 新建相册”卡片，点击打开原生 `<dialog>` 输入名字。
- 空状态：没有相册时显示说明；上传者显示“新建第一个相册”。
- 分页：相册很多时用“加载更多”按钮 + IntersectionObserver 自动加载。

### 8.3 相册页

- 封面区：600×600 缩略图作为封面大图（带宽优先），`fetchpriority="high"`；点击打开灯箱看全图。
- 精选区：`tier='featured'` 的 600×600 缩略图网格。
- 分割线：1px 低对比度线，下方“全部照片”。
- 全部照片：包含封面/精选/其他，按 `created_at DESC` 分页，每页 60。
- 照片卡片：`<button>` 打开灯箱；`<img>` 带 `alt`、`width/height`、`loading="lazy"`。
- 操作：
  - 本次 session 上传的照片：显示“设为封面 / 精选 / 其他 / 删除”；
  - 管理员：额外显示“公开/私密”切换、删除任意照片；
  - 操作后局部更新 DOM，不整页刷新。
- 私密相册：查看者+可见，页面显示“私密”徽标。
- 空相册：上传者显示“上传照片”按钮。

### 8.4 登录

- 右上角“登录”按钮，打开原生 `<dialog>`：
  - 只有一个密码输入框，`autocomplete="current-password"`，`autofocus`；
  - 提交按钮；错误信息 `aria-live="polite"`；
  - `closedby="any"` 支持点击遮罩关闭；Safari 等不支持时用 pointerdown/up 回退；
  - `dialog:modal { overscroll-behavior: contain; }`，`::backdrop { overflow: hidden; overscroll-behavior: contain; }`，防止背景滚动；
  - 不手写 focus trap，使用原生 `showModal()`。
- 登录成功：`location.reload()`，让服务端重新渲染角色相关内容。
- 登录失败：显示“密码错误”，不区分用户不存在/密码错误。
- 登出：POST `/api/logout`，reload。
- 无 JS：`<noscript>` 提供 `/login` 链接。

### 8.5 上传页

- 权限：上传者+；否则 403 页面 + 登录按钮。
- 相册选择：
  - `<select>` 列出当前角色可见相册；
  - “新建相册”选项打开对话框，创建后自动选中；
  - URL `?album=<id>` 可预选。
- 文件选择：
  - 拖拽区 + `<input type="file" multiple accept="image/avif,image/heic,image/heif,image/jpeg,image/png,image/webp">`；
  - 显示支持格式、单文件上限、最大像素。
- 队列：
  - 每行：文件名、大小、阶段、进度、状态、取消/重试；
  - 阶段：检测 → 解码 → 缩放 → 编码全图 → 编码缩略图 → 元数据 → 上传；
  - 编码阶段用不确定进度条 + 阶段文字；上传阶段用字节进度；
  - 总体进度条。
- 结果：
  - 成功：缩略图 + “已上传/已存在”；
  - 失败：原因 + 重试；
  - “本次上传”区域支持设封面/精选/其他/删除。
- 提示：
  - “图片在浏览器本地转码，原图不会上传；请保持页面打开。”
  - “EXIF 已保留 / EXIF 保留失败（原因）”。
- 无 JS：显示说明，不可用。

### 8.6 管理台

- 权限：管理员；否则 404/403。
- 顶部 tab：操作日志 / 用户管理 / 统计。
- 操作日志：
  - 表格：时间、用户、角色、动作、目标、IP、UA（截断）、详情；
  - 筛选：动作、用户、时间范围；
  - 分页：cursor；
  - 不记录“查看”行为。
- 用户管理：
  - 列表：ID、角色、创建时间、最后登录、状态；
  - 新建用户：角色 + 密码（可生成 16 位随机密码，只显示一次）；
  - 重置密码：输入新密码或生成；重置后删除该用户所有 session；
  - 禁用/启用；删除（确认对话框）；
  - 保护最后一个管理员。
- 统计：相册数、照片数、用户数、总占用、磁盘剩余。
- 所有破坏性操作使用原生 `<dialog>` 确认，默认焦点在“取消”。

### 8.7 灯箱

- 原生 `<dialog>`，`showModal()`；`closedby="any"` + 回退。
- 内容：全图 `<img>`、相册名、拍摄时间/尺寸（可选）、上一张/下一张/关闭。
- 键盘：←/→ 切换，Esc 关闭。
- 加载：打开时显示骨架/进度；`decoding="async"`；失败显示重试。
- 预加载：可选预取下一张全图（`<link rel="prefetch">` 或 `new Image()`），弱网下默认关闭。
- 不把全图放进首屏 HTML；只在用户打开时请求。

### 8.8 响应式、无障碍、主题

- 断点：`< 640px` 单列；`640–1024px` 2–3 列；`> 1024px` 3–5 列。
- 相册网格：`grid-template-columns: repeat(auto-fill, minmax(300px, 350px)); justify-content: center;`。
- 所有图片有 `alt`；装饰性元素 `aria-hidden="true"`。
- 所有按钮/链接可键盘访问；焦点样式明显。
- 颜色对比度 ≥ 4.5:1；支持 `prefers-color-scheme: dark`。
- 支持 `prefers-reduced-motion: reduce`，关闭过渡/动画。
- 不使用 `backdrop-filter`（弱设备 GPU 开销）。
- 字体：系统字体栈，不加载 Web Font。

### 8.9 空状态与错误状态

- 首页无相册：说明 + 新建按钮（上传者）。
- 相册无照片：说明 + 上传按钮（上传者）。
- 404：简洁页面 + 返回首页。
- 403：说明 + 登录按钮。
- 500：通用错误 + 请求 ID（便于查日志）。
- 上传失败：逐文件原因，不阻塞其他文件。

---

## 9. 缓存、性能与带宽

### 9.1 HTTP 缓存策略

| 资源 | Cache-Control | 说明 |
| --- | --- | --- |
| 媒体（公开） | `public, max-age=31536000, immutable` | 文件名是内容 MD5 |
| 媒体（私密） | `private, max-age=31536000, immutable` | 只进浏览器缓存 |
| 封面 | 同上 + `?v=<cover_md5>` | 封面变化 URL 变化 |
| 构建产物（JS/CSS/wasm） | `public, max-age=31536000, immutable` | Vite 哈希文件名 |
| HTML | `private, no-cache` | 角色相关，每次校验 |
| API | `private, no-store` | 避免角色数据串缓存 |
| 字体 | 无 | 不使用 Web Font |

- 支持 `ETag`/`If-None-Match`，媒体 304 响应。
- 不压缩 AVIF；Caddy 只压缩 HTML/JS/CSS/JSON。
- 构建时预压缩 `.br`/`.gz`，服务端按 `Accept-Encoding` 直接发预压缩文件，避免运行时压缩 CPU。

### 9.2 图片加载优先级

- 首页第一张封面：`fetchpriority="high"`，不 lazy。
- 相册页封面：`fetchpriority="high"`，不 lazy。
- 其余缩略图：`loading="lazy"`，不加 `fetchpriority="low"`（进入视口后正常优先级）。
- 灯箱全图：用户打开后加载，`decoding="async"`；当前图可 `fetchpriority="high"`。
- 不使用 `fetchpriority="high"` 超过 1–2 张，避免带宽竞争。
- 所有 `<img>` 带 `width`/`height` 或 CSS `aspect-ratio`，避免 CLS。

### 9.3 分页与懒加载

- 首页相册：默认 50，cursor 分页；“加载更多”+ IntersectionObserver。
- 相册全部照片：每页 60，cursor 分页；无限滚动 + 兜底按钮。
- 精选：一次最多 100；超过则分页（v1 预计不会）。
- 灯箱：只加载当前图；可选预取下一张（默认关闭）。
- 长列表使用 `content-visibility: auto` + `contain-intrinsic-size` 于首屏之外的区块，减少渲染开销；不要用于首屏。

### 9.4 服务端性能

- SQLite WAL + prepared statements + 索引；避免 N+1。
- 相册列表用一条 SQL 带封面和计数；相册详情用 3–4 条查询。
- 媒体路由只查相册（内存缓存 60s + 变更时失效），不查照片表。
- 上传流式写盘 + 流式 MD5；AVIF 校验用随机读，不整文件入内存。
- 单进程；上传并发 2；登录 scrypt 并发 1（避免内存峰值）。
- 静态资源由 Node 发送；Caddy 负责 TLS/HTTP2；可选让 Caddy 直接服务 `/assets/*`。
- 请求超时：`headersTimeout=10s`、`requestTimeout=30s`、`bodyLimit` 按路由设置。

### 9.5 构建与传输

- Vite 输出：
  - `app.js`（首页/相册/登录/灯箱）< 15KB gzip；
  - `upload.js` + wasm 按需加载；
  - `admin.js` 仅管理台加载；
  - `app.css` < 15KB gzip。
- wasm 自托管，哈希文件名，长缓存；`Content-Type: application/wasm`。
- 不使用 CDN（弱服务器/隐私）；所有资源同源。
- 构建时生成 `manifest.json`，服务端模板注入哈希文件名。
- 预压缩：`app.js.br`、`app.css.br` 等；Node 读取预压缩文件。

### 9.6 性能预算

| 指标 | 目标 |
| --- | --- |
| 首页 HTML | < 30KB gzip |
| 首页首屏图片 | < 200KB（约 4–6 张封面） |
| 相册页首屏 | < 400KB（封面 + 6 张精选） |
| 单张缩略图 | < 50KB（600×600 AVIF） |
| 单张全图 | 典型 < 1.5MB，最大 50MB |
| LCP（Slow 4G） | < 2.5s |
| CLS | < 0.1 |
| INP | < 200ms |
| 服务端 HTML/API | P95 < 100ms（弱服务器） |
| 内存 | < 256MB（不含上传临时缓冲） |

### 9.7 监控指标

- `/healthz`：DB 可读、数据目录可写、磁盘剩余。
- 日志：请求错误、上传失败、校验失败、磁盘不足。
- 管理台统计：照片数、总字节、磁盘剩余。
- 可选：每日审计日志统计（登录失败次数、上传量）。

---

## 10. 安全

### 10.1 认证

- 仅密码，无用户名。
- 密码查找：`password_lookup = HMAC-SHA256(AUTH_PEPPER, password)`，唯一索引，O(1) 找到用户。
- 密码哈希：`scrypt(password, salt, N=2^15, r=8, p=1, keylen=32)`；编码为 `scrypt$N$r$p$salt$hash`。
- 查找未命中时也执行一次 dummy scrypt，避免时序泄露“密码是否存在”。
- 密码长度 8–128；管理员生成密码 16 位 base64url。
- 登录失败统一返回“密码错误”；记录审计（IP、UA、时间），不记录密码。
- 登录限流：每 IP 10 次/分钟、100 次/小时；全局 100 次/分钟；超限 429 + `Retry-After`。
- 首次部署：CLI `pnpm create-admin` 创建管理员；或 `ADMIN_PASSWORD` 环境变量首次启动创建。禁止公开的“首次设置”页面。

### 10.2 会话

- 登录生成 32 字节随机 token（base64url），cookie 存 token；DB 存 SHA-256(token)。
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`；HTTPS 下 `Secure` + `__Host-` 前缀。
- 有效期：滑动 7 天，绝对上限 30 天；每小时最多更新一次 `last_seen_at`。
- 登录时若已有 session，删除旧 session（防 fixation）。
- 登出删除当前 session；管理员重置密码/禁用用户时删除该用户所有 session。
- 过期 session 每小时清理。

### 10.3 CSRF

- `SameSite=Lax` 为基础。
- 所有 POST/PATCH/DELETE 校验：
  - `Origin` 必须等于 `PUBLIC_ORIGIN`（或同 host）；
  - 若浏览器发送 `Sec-Fetch-Site`，必须是 `same-origin`；
  - JSON 接口要求 `Content-Type: application/json`；
  - 前端带 `X-Requested-With: fetch`。
- 不满足返回 403 `CSRF`。

### 10.4 XSS / SQL 注入 / 路径

- 所有 HTML 插值走 `escapeHtml`；JS 更新 DOM 用 `textContent`，不用 `innerHTML`。
- 初始数据 JSON 注入时把 `<` 转义为 `\u003c`。
- SQL 全部 prepared statement；不拼接用户输入。
- 相册目录由服务端生成；媒体路由的文件名用正则白名单；`path.resolve` 后校验仍在相册目录内。
- 拒绝符号链接；`lstat` 检查。
- CSP 禁止内联脚本；`script-src 'self' 'wasm-unsafe-eval'`；`object-src 'none'`；`frame-ancestors 'none'`。

### 10.5 上传安全

- 只接受 AVIF；魔数 + 容器结构校验。
- 大小/像素/元数据大小限制；拒绝动画。
- 临时文件随机名、0600；启动清理。
- 上传接口要求上传者+；CSRF；限流；并发限制。
- 服务端不执行任何图片解码器，降低攻击面。
- 文件名由服务端 MD5 生成，不使用客户端文件名作为路径。
- 原始文件名只存 DB，展示时转义。

### 10.6 隐私与可见度

- 私密相册/照片对公众返回 404，不返回 403。
- 私密相册不出现在公众首页/API。
- `hidden/` 缩略图同样受保护。
- 公开相册封面必须是公开照片，避免封面泄露。
- `robots.txt` 默认 `Disallow: /`；如需要公开索引再配置。
- 不记录“查看”行为；审计只记录登录、上传、建相册、删除、改可见度、用户管理。
- EXIF 可能含 GPS；公开照片的 EXIF 视为公开。管理台提示，v1 不自动剥离。

### 10.7 限流与配额

- 登录：见 10.1。
- 上传：每 session 1 并发、每 IP 10 次/分钟；全局 2 并发。
- 相册创建：每用户 10 次/小时。
- 磁盘：`MAX_TOTAL_BYTES`（默认 20GB）、`MIN_FREE_BYTES`（默认 1GB）；低于阈值拒绝上传 507。
- 单相册照片数：默认 5000；单用户相册数：默认 200。
- 请求体：JSON 64KB；multipart 按路由限制。

### 10.8 审计日志

记录动作：

- `login.success` / `login.failure` / `logout`
- `album.create` / `album.delete` / `album.visibility`
- `photo.upload` / `photo.delete` / `photo.tier` / `photo.visibility`
- `user.create` / `user.update` / `user.delete` / `user.password_reset`

字段：时间、用户、session、IP、UA、目标类型/ID、详情 JSON。不记录密码、token、照片内容。保留 180 天，每日清理。

### 10.9 安全头

```text
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains   # 仅 HTTPS
```

- 若必须内联关键 CSS，使用 nonce，不用 `unsafe-inline`。
- `wasm-unsafe-eval` 仅允许 WebAssembly，不允许 `eval`。

### 10.10 依赖与供应链

- 锁定 `pnpm-lock.yaml`；CI 跑 `pnpm audit`。
- 依赖尽量少；wasm 自托管，不从 CDN 加载。
- 定期更新；升级前跑测试。
- 生产 `NODE_ENV=production`，不安装 devDependencies。

---

## 11. 部署与运维

### 11.1 目录与权限

```text
/opt/kig-photo-space/          # 代码 + dist
/var/lib/kig-photo-space/      # DATA_DIR
  db.sqlite
  data/...
  backups/
```

- 运行用户 `kig`，数据目录 `0750`，文件 `0640`。
- `AUTH_PEPPER` 放 systemd `EnvironmentFile`（`0600`），不要提交仓库。
- 生产必须 HTTPS；cookie `Secure`。

### 11.2 systemd

```ini
[Unit]
Description=Kig Photo Space
After=network.target

[Service]
Type=simple
User=kig
Group=kig
WorkingDirectory=/opt/kig-photo-space
Environment=NODE_ENV=production
EnvironmentFile=/etc/kig-photo-space.env
ExecStart=/usr/bin/node --max-old-space-size=256 dist/server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/kig-photo-space
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

### 11.3 Nginx

部署时监听本地高端口，配置nginx在域名合适时代理到本机高端口。

### 11.4 配置项

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/kig-photo-space
PUBLIC_ORIGIN=https://photos.example.com
AUTH_PEPPER=<32+ bytes base64>
COOKIE_SECURE=true
SESSION_TTL_DAYS=7
SESSION_MAX_DAYS=30
MAX_FULL_BYTES=52428800
MAX_THUMB_BYTES=2097152
MAX_IMAGE_DIMENSION=12000
MAX_IMAGE_PIXELS=80000000
MAX_UPLOAD_FILES=50
UPLOAD_CONCURRENCY=2
MAX_TOTAL_BYTES=21474836480
MIN_FREE_BYTES=1073741824
TRASH_RETENTION_DAYS=7
AUDIT_RETENTION_DAYS=180
TRUST_PROXY=false
LOG_LEVEL=info
```

- 开发环境可自动生成 `data/.secret` 作为 pepper；生产必须显式配置。
- `TRUST_PROXY=true` 仅在 Caddy/Nginx 同机时启用，否则 IP 可伪造。

### 11.5 备份与恢复

- **DB**：`node:sqlite` 的 `backup()` 生成一致性副本；或 `sqlite3 db.sqlite ".backup ..."`。
- **文件**：`rsync -a --delete data/ backup/data/`。
- **一致性**：优先文件系统快照（LVM/ZFS/btrfs）；否则低峰期备份，先文件后 DB，再校验。
- **恢复**：停服务 → 恢复 DB + data → 启动 → `/healthz` → 抽查照片。
- **保留**：每日备份保留 7 天，每周保留 4 周。
- **演练**：每季度做一次恢复演练。

### 11.6 升级与迁移

1. 备份 DB + data。
2. `pnpm install --prod` + `pnpm build`。
3. 启动时自动迁移；失败则回滚并拒绝启动。
4. 重启 systemd；检查 `/healthz` 和首页。
5. 回滚：恢复上一版代码 + DB 备份。

### 11.7 日志与监控

- 应用日志到 stdout/journald；`LOG_LEVEL=info`。
- 不记录密码、cookie、token、完整 EXIF。
- 审计日志在 DB，管理台可查。
- 健康检查：`GET /healthz` 返回 `{ ok, db, dataDir, diskFree }`。
- 磁盘不足告警：`MIN_FREE_BYTES` 触发上传拒绝 + 日志。
- 可选：systemd `OnFailure` 发邮件/webhook。

### 11.8 资源限制

- Node `--max-old-space-size=256`。
- systemd `MemoryMax=512M`、`CPUQuota=80%`（按机器调整）。
- 上传并发 2；scrypt 并发 1。
- SQLite `cache_size=-4000`。
- 不在服务器上跑图片处理/缩略图任务。

---

## 12. 测试计划

### 12.1 单元测试

- `sanitizeAlbumName` / `dirKey`：中文、空格、大小写、保留名、路径穿越。
- `parseAvif`：合法/非法 ftyp、meta、iloc、ispe、av1C、grid、动画、尾随字节。
- `validateThumbnail`：600×600、8-bit、4:2:0、错误尺寸/位深。
- `injectExif`：注入后 item 存在、像素不变、可解码。
- `setTiffOrientation`：Orientation 改为 1。
- 密码：scrypt 编码/校验、HMAC lookup、dummy 校验。
- 权限：角色矩阵、session 归属、封面规则、最后管理员。
- cursor 编解码。

### 12.2 集成测试

- Fastify `inject` + 临时 DATA_DIR + 临时 SQLite。
- 登录/登出/me；错误密码；限流。
- 相册创建/列表/详情/可见度/删除。
- 上传：合法 AVIF、非法 AVIF、错误缩略图、超大文件、重复上传。
- 照片档次/封面/可见度/删除；文件移动正确。
- 媒体路由：公开/私密/隐藏/封面；缓存头；304。
- 管理：用户 CRUD、最后管理员保护、日志分页。
- 审计日志：动作、IP、目标。

### 12.3 E2E（Playwright）

- 首页 → 登录 → 相册列表变多。
- 上传一张小 JPEG（真实 wasm 编码）→ 缩略图出现 → 设封面/精选。
- 管理员创建用户 → 新用户登录 → 权限正确。
- 灯箱键盘操作。
- 移动端视口截图（可选）。

### 12.4 手工测试矩阵

| 场景 | 检查 |
| --- | --- |
| Chrome/Edge/Firefox/Safari 最新版 | 首页、相册、登录、灯箱 |
| iPhone HEIC | 上传、方向、EXIF |
| 大图 8000×6000 | 内存、编码时间、失败提示 |
| 10-bit/HDR HEIC | 是否可解码、颜色是否可接受 |
| 已有 AVIF（含 EXIF） | 不转码、缩略图、EXIF 保留 |
| 私密相册/照片 | 公众 404、查看者可见 |
| 公开相册私密封面 | 拒绝设置/拒绝改公开 |
| 重复上传 | 去重、不重复占盘 |
| 磁盘满 | 507、临时文件清理 |
| 弱网 Slow 3G | 首屏、懒加载、CLS |
| 键盘/屏幕阅读器 | 焦点、标签、对话框 |

### 12.5 性能/安全/无障碍

- Lighthouse（移动端，Slow 4G）：LCP/CLS/INP 达标。
- `autocannon`：首页/相册/媒体 QPS 与 CPU。
- `pnpm audit`；可选 OWASP ZAP baseline。
- axe-core：首页/相册/登录/上传/管理台。
- 手动越权测试：直接请求私密媒体、API、管理接口。

---

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 浏览器大图编码内存/耗时 | 上传失败/卡顿 | Worker、最大边/像素限制、并发 1、进度、失败提示 |
| EXIF 注入容器兼容性 | EXIF 丢失/图片损坏 | 共享解析器、真实夹具、注入后解码验证、ExifTool wasm 回退、失败拒绝 |
| HEIC 兼容性 | iPhone 照片无法上传 | libheif wasm、样本测试、明确错误、建议转 JPEG |
| 服务端不验像素 | 损坏 AVIF 入库 | 客户端上传前解码验证；服务端结构校验；信任持密码用户 |
| 弱服务器磁盘/带宽 | 站点不可用 | 只存 AVIF、缩略图、懒加载、配额、磁盘告警、回收站 |
| 密码即身份 | 弱密码/撞库 | 强密码、限流、scrypt、HMAC 查找、审计 |
| 私密封面泄露 | 隐私事故 | 公开相册封面必须公开；媒体路由校验 |
| 缓存不失效 | 封面旧图 | 封面 URL 带 `?v=<md5>` |
| 相册名冲突/路径问题 | 创建失败/安全 | 规范化、`dir_key` 唯一、保留名、服务端生成路径 |
| 数据丢失 | 不可恢复 | 回收站、备份、恢复演练、审计 |
| 依赖/wasm 供应链 | 安全/稳定性 | 锁文件、自托管、审计、最小依赖 |
| 时区/日期显示 | 用户困惑 | 存 UTC 毫秒，前端本地化 |

---

## 15. 待确认问题

以下问题不阻塞开工，但会影响细节；默认值已在括号中给出。

1. **技术栈**：Node + Fastify + 原生前端是否接受？（默认：接受）
2. **全图最大边**：默认 6000px，超出客户端等比缩小；是否要保留原始分辨率？（默认：6000px）
3. **原图**：v1 只保留 AVIF，不保留 JPEG/HEIC 原图；是否接受？（默认：接受）
4. **相册重命名**：v1 不支持，删除重建；是否需要？（默认：不需要）
5. **私密照片作公开相册封面**：v1 禁止；是否接受？（默认：禁止）
6. **上传者设封面**：按 plan，上传者可把本次上传的照片设为任意相册封面；是否要限制为“自己创建的相册”？（默认：不限制）
7. **EXIF GPS**：按 plan 保留；是否需要在公开照片上默认剥离 GPS？（默认：保留 + 提示）
8. **UI 语言**：先中文；是否需要英文？（默认：中文）
9. **部署**：Linux + systemd + Caddy；是否需要 Docker？（默认：不需要）
10. **回收站/审计保留**：7 天 / 180 天；是否调整？（默认：7/180）
11. **浏览器支持**：最近两个版本的 Chrome/Edge/Firefox/Safari；是否要支持旧版？（默认：最近两个版本）
12. **照片多相册归属**：v1 一张照片一个相册；是否需要一张照片属于多个相册？（默认：不需要）

---

## 16. 附录

### A. AVIF 校验规则（服务端）

**接受：**

- `ftyp` 存在，compatible brand 含 `avif`。
- `meta` 存在，含 `pitm`、`iinf`、`iloc`、`iprp`。
- 主 item 为 `av01` 或 `grid`；`grid` 的 `dimg` 引用完整。
- `ispe` 宽高 > 0；全图 ≤ 12000px、≤ 80MP；缩略图 = 600×600。
- `av1C` 存在；缩略图 8-bit、4:2:0、非 monochrome。
- `iloc` extent 在文件内；`data_reference_index=0`；`construction_method` 0/1。
- `mdat` 非空；顶层 box 覆盖整个文件。
- `Exif`/XMP item ≤ 1MB。

**拒绝：**

- `avis` 动画 brand。
- 无 `meta`/`pitm`/`iloc`/`mdat`。
- 主 item 不是 `av01`/`grid`。
- `ispe` 缺失/为 0/超限。
- `av1C` 缺失/字段非法。
- 缩略图不是 600×600、不是 8-bit、不是 4:2:0。
- `iloc` extent 越界；`construction_method=2`；外部 data reference。
- 尾随垃圾字节。
- 文件/元数据超限。

### B. 编码参数速查

```ts
// 全图
{
  quality: 60,
  speed: 8,
  subsample: 420,
  bitDepth: 8,
  lossless: false,
}

// 缩略图
{
  quality: 50,
  speed: 8,
  subsample: 420,
  bitDepth: 8,
  lossless: false,
}
```

### C. 目录结构（代码）

```text
kig-photo-space/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vite.config.ts
  .env.example
  README.md
  plan.md
  plan-detail.md
  data/                         # 运行时，gitignore
  src/
    server/
      index.ts
      config.ts
      db/
        index.ts
        migrations/001_init.sql
      auth/
        password.ts
        session.ts
        permissions.ts
      routes/
        pages.ts
        auth.ts
        albums.ts
        photos.ts
        media.ts
        admin.ts
      services/
        albums.ts
        photos.ts
        storage.ts
        audit.ts
        avif-validate.ts
      templates/
        layout.ts
        home.ts
        album.ts
        upload.ts
        admin.ts
        error.ts
      http/
        csrf.ts
        rate-limit.ts
        errors.ts
    client/
      main.ts
      login.ts
      lightbox.ts
      album.ts
      upload/
        index.ts
        worker.ts
        pipeline.ts
        detect.ts
        decode.ts
        encode.ts
        exif.ts
        avif-exif.ts
        md5.ts
      admin.ts
      styles/app.css
    shared/
      avif/
        parse.ts
        types.ts
      types.ts
      cursor.ts
  tests/
    unit/
    integration/
    e2e/
    fixtures/
  scripts/
    create-admin.ts
    purge-trash.ts
    backup.ts
    fsck.ts
  deploy/
    systemd/kig-photo-space.service
    Caddyfile
  docs/
    deployment.md
    operations.md
    security.md
```

### D. 参考资料

- AVIF / HEIF ISOBMFF 结构：ISO/IEC 14496-12、AV1 Image File Format (AVIF) spec。
- libavif：https://github.com/AOMediaCodec/libavif
- `@phenomen/libavif-wasm`：https://www.npmjs.com/package/@phenomen/libavif-wasm
- `heic-decode` / libheif-js：https://www.npmjs.com/package/heic-decode
- `exifr`：https://www.npmjs.com/package/exifr
- `aeo-image`（ISOBMFF 重写参考，MIT）：https://www.npmjs.com/package/aeo-image
- Fastify：https://fastify.dev/
- Node `node:sqlite`：https://nodejs.org/api/sqlite.html
- MDN `<dialog>`：https://developer.mozilla.org/docs/Web/HTML/Element/dialog
- web.dev 图片优先级/懒加载：https://web.dev/articles/browser-level-image-lazy-loading

---

## 17. 开工顺序（TL;DR）

1. 建骨架 + DB + 健康检查。
2. 认证/角色/审计。
3. 相册 + 媒体路由 + 首页/相册页。
4. 上传流水线（先 JPEG，再 HEIC/AVIF，再 EXIF 注入）。
5. 管理台。
6. 性能/安全/部署。
7. 用真实照片和慢网做验收。
8. 注意在格式转换的过程中，图片可能是hdr的，需要保留hdr，转换成hdr的avif。
9. 注意上传图片时，用户应当可以选择文件夹，上传一堆照片。