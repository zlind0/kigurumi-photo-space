# Kig Photo Space

一个为**低带宽、低性能服务器**设计的私密照片分享站。

核心思路：**浏览器负责解码、缩放、转码，服务器只存 AVIF + SQLite**。服务器不解码、不编码、不生成缩略图，因此 1 核 / 512MB 的小机器也能稳定运行。

## 功能

- 公众无需密码浏览公开照片；查看者登录后可看私密相册/照片。
- 上传者在浏览器内把 JPEG / PNG / WebP / HEIC / AVIF 转成 AVIF，并生成 600×600 缩略图。
- **HDR 保留**：HDR 源（10-bit HEIC、HDR AVIF）会转成 10-bit BT.2020 PQ/HLG AVIF，而不是压成 SDR。
- **文件夹上传**：可以一次选择整个文件夹，或把文件夹拖进上传区，递归收集其中的照片。
- 相册封面 / 精选 / 其他三档；公开 / 私密可见度。
- **人物筛选**：管理员维护人物（名字、200×200 AVIF 头像、HSL accent），按相册标记人物；首页人物条支持单选/多选/全选，选中人物以 accent 发光。
- 灯箱查看、键盘切换、下载 AVIF 或浏览器内转 JPEG。
- 管理员：用户管理、密码重置、操作日志、站点统计、相册/照片可见度与删除。
- 服务端零图片编解码；只做 AVIF 容器结构校验、MD5、文件搬运。
- 内容哈希文件名 + `immutable` 长缓存；HTML 每次校验。
- 单 Node 进程 + SQLite WAL；systemd + Nginx 部署。

## 技术栈

| 层 | 选择 |
| --- | --- |
| 服务端 | Node.js 24 + Fastify 5 + 内置 `node:sqlite` |
| 前端 | TypeScript + Vite，无 UI 框架，服务端渲染 HTML + 原生 JS |
| 图片 | 只存 AVIF；全图 + 600×600 缩略图 |
| 转码 | Web Worker + libavif wasm（8-bit）+ 自编译 libaom wasm（10-bit HDR） |
| HEIC | libheif-js wasm |
| EXIF | exifr 读取 + 自研 AVIF 容器重写注入 |
| 认证 | 仅密码；scrypt + HMAC 查找键；服务端 session |

## 快速开始（开发）

要求：Node.js 24+、pnpm 10+。

```bash
pnpm install
pnpm build
DATA_DIR=./data AUTH_PEPPER=dev-pepper-please-change-0123456789 \
  PUBLIC_ORIGIN=http://127.0.0.1:3000 PORT=3000 \
  node dist/scripts/create-admin.js 'your-admin-password'
DATA_DIR=./data AUTH_PEPPER=dev-pepper-please-change-0123456789 \
  PUBLIC_ORIGIN=http://127.0.0.1:3000 PORT=3000 \
  node dist/server/index.js
```

打开 <http://127.0.0.1:3000>，用刚创建的管理员密码登录。

开发时也可以：

```bash
pnpm dev          # 编译服务端并 watch
pnpm build:client # 只构建前端
pnpm test         # 单元 + 集成测试
pnpm typecheck
```

## 生产部署

见 [docs/deployment.md](docs/deployment.md)。最短路径：

```bash
pnpm install --prod=false
pnpm build
sudo install -d -o kig -g kig -m 0750 /var/lib/kig-photo-space
sudo install -m 0600 deploy/systemd/kig-photo-space.env.example /etc/kig-photo-space.env
# 编辑 /etc/kig-photo-space.env，设置 AUTH_PEPPER / PUBLIC_ORIGIN
sudo cp deploy/systemd/kig-photo-space.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now kig-photo-space
sudo -u kig env $(cat /etc/kig-photo-space.env | xargs) node dist/scripts/create-admin.js
```

Nginx 反向代理示例见 [deploy/nginx/kig-photo-space.conf](deploy/nginx/kig-photo-space.conf)。

## HDR 处理

上传流水线会先判断源文件是否 HDR：

| 源 | 处理 |
| --- | --- |
| AVIF（含 HDR） | **全图原样上传**，不重新编码，HDR/EXIF/ICC/irot/imir 全部保留；缩略图由浏览器解码后生成 SDR 600×600 |
| HEIC 10-bit + PQ/HLG | libheif 解码为 16-bit RGBA → 10-bit BT.2020 PQ/HLG AVIF（自编译 libaom wasm） |
| HEIC 10-bit SDR | 保留 10-bit，编码为 10-bit SDR AVIF |
| HEIC 8-bit | 8-bit 4:2:0 AVIF |
| JPEG/PNG/WebP | 8-bit 4:2:0 AVIF；若检测到 HDR 元数据会提示“已转为 SDR” |

HDR 编码器是 `tools/wasm/avif_hdr_enc.c` + libaom 10-bit wasm，构建说明见 [tools/wasm/README.md](tools/wasm/README.md)。它只在检测到 10-bit 源时按需加载（约 3.2MB wasm，gzip 后约 1MB）。

> 说明：浏览器原生 WebCodecs 的 AV1 编码器目前只支持 8-bit，因此 HDR 10-bit 编码使用自编译的 libaom wasm。8-bit 路径使用 `@phenomen/libavif-wasm`。

## 文件夹上传

上传页提供两个入口：

- **选择照片**：`<input type="file" multiple>`。
- **选择文件夹**：`<input type="file" webkitdirectory>`，浏览器会递归列出文件夹内所有文件。

也可以把文件夹直接拖进上传区；前端用 `DataTransferItem.webkitGetAsEntry()` 递归遍历目录。非图片文件、隐藏文件、`__MACOSX` 会被跳过。

## 目录结构

```text
data/
  db.sqlite
  .secret                 # 开发环境自动生成；生产用 AUTH_PEPPER
  tmp/                    # 上传临时文件
  .trash/                 # 删除的相册
  backups/                # 迁移前/手动备份
  <相册目录>/
    cover.avif            # 封面全图（硬链接）
    cover.thumb.avif      # 封面缩略图（硬链接）
    top/                  # 公开 + 精选/封面
    others/               # 公开 + 其他
    hidden/               # 私密照片
```

照片文件名是内容 MD5：`<md5>.avif` / `<md5>.thumb.avif`。同一相册内去重；跨相册优先硬链接复用。

## 常用脚本

```bash
node dist/scripts/create-admin.js [password]   # 创建管理员；不传密码则生成
node dist/scripts/backup.js                    # VACUUM INTO 备份数据库
node dist/scripts/purge-trash.js               # 清理过期回收站
node dist/scripts/fsck.js [--fix]              # 检查缺失/孤儿文件
```

## 测试

```bash
pnpm test
```

覆盖：

- AVIF 容器解析/校验（ftyp、meta、iloc、ispe、av1C、grid、动画、尾随字节）。
- EXIF 注入与 TIFF Orientation 重写。
- 10-bit HDR AVIF 编码（libaom wasm + 自研 muxer）。
- 相册名规范化、密码 scrypt/HMAC、cursor。
- Fastify 集成：登录、相册、上传、去重、缩略图校验、私密可见度、封面规则、删除、最后管理员保护、审计日志。

## 已知限制

- 服务端只校验 AVIF 容器结构，不验证像素能否解码（信任持密码用户；客户端上传前会自己解码一次）。
- 浏览器端 HDR 编码依赖 WebAssembly，低端设备上大图会较慢；上传队列串行处理，避免内存峰值。
- 不支持动画 AVIF/HEIC、视频、GIF。
- 相册重命名、拖拽排序、一张照片多相册、搜索/标签不在 v1 范围。
- EXIF 可能含 GPS；公开照片的 EXIF 视为公开，管理台会提示，v1 不自动剥离。
- 10-bit HDR 编码器为单线程 libaom，速度优先（speed 8），质量 60；可在 `src/client/upload/index.ts` 调整。

## 许可与第三方组件

本项目自身未声明开源许可证。运行时依赖与 wasm 编解码器的许可信息见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。特别注意 `libheif-js`
（LGPL-3.0）和 libaom（BSD-2-Clause + AOM Patent License 1.0）。

## 文档

- [部署](docs/deployment.md)
- [运维](docs/operations.md)
- [安全](docs/security.md)
- [详细设计](plan-detail.md)
