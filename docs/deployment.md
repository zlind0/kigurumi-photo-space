# 部署

目标环境：Linux（Debian/Ubuntu 或同类）、Node.js 24、Nginx、systemd。单进程、单机即可。

## 1. 准备

```bash
# Node.js 24（示例：NodeSource 或 nvm）
node -v   # 需要 v24.x

# pnpm
corepack enable
corepack prepare pnpm@10 --activate

# 运行用户
sudo useradd --system --home /opt/kig-photo-space --shell /usr/sbin/nologin kig
sudo install -d -o kig -g kig -m 0755 /opt/kig-photo-space
sudo install -d -o kig -g kig -m 0750 /var/lib/kig-photo-space
```

## 2. 部署代码

```bash
sudo -u kig git clone <repo> /opt/kig-photo-space
cd /opt/kig-photo-space
sudo -u kig pnpm install --frozen-lockfile
sudo -u kig pnpm build
```

`pnpm build` 会：

1. `tsc` 编译服务端到 `dist/server`，复制 SQL 迁移。
2. Vite 构建前端到 `dist/public`（含 wasm、manifest）。
3. 生成 `.br` / `.gz` 预压缩资源。

生产运行只需要 `dist/`、`node_modules/`（生产依赖）和 `package.json`。如果使用 `pnpm install --prod`，请先在有 devDependencies 的环境完成构建，再部署 `dist/`。

## 3. 配置

```bash
sudo install -m 0600 deploy/systemd/kig-photo-space.env.example /etc/kig-photo-space.env
sudo editor /etc/kig-photo-space.env
```

至少修改：

```dotenv
DATA_DIR=/var/lib/kig-photo-space
PUBLIC_ORIGIN=https://photos.example.com
AUTH_PEPPER=<openssl rand -base64 48>
COOKIE_SECURE=true
TRUST_PROXY=true
```

- `AUTH_PEPPER` 用于密码查找键 HMAC。**一旦更换，所有用户密码都会失效**，请备份。
- `TRUST_PROXY=true` 仅在 Nginx 同机时启用，否则客户端可伪造 IP。
- `COOKIE_SECURE=true` 要求 HTTPS；本地 HTTP 调试时设为 `false`。

## 4. 创建管理员

```bash
cd /opt/kig-photo-space
sudo -u kig env $(grep -v '^#' /etc/kig-photo-space.env | xargs) \
  node dist/scripts/create-admin.js
```

不传密码时会生成 16 位随机密码并只显示一次。也可以：

```bash
sudo -u kig env $(grep -v '^#' /etc/kig-photo-space.env | xargs) \
  node dist/scripts/create-admin.js 'a-strong-password'
```

## 5. systemd

```bash
sudo cp deploy/systemd/kig-photo-space.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kig-photo-space
sudo systemctl status kig-photo-space
curl -s http://127.0.0.1:3000/healthz
```

日志：

```bash
journalctl -u kig-photo-space -f
```

## 6. Nginx + TLS

```bash
sudo cp deploy/nginx/kig-photo-space.conf /etc/nginx/sites-available/kig-photo-space
sudo ln -s /etc/nginx/sites-available/kig-photo-space /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

用 certbot 申请证书：

```bash
sudo certbot --nginx -d photos.example.com
```

确认：

- `https://photos.example.com/healthz` 返回 `{"ok":true,...}`。
- 登录后上传一张照片，灯箱能打开。
- 私密相册在未登录时返回 404。

## 7. 升级

```bash
cd /opt/kig-photo-space
sudo -u kig node dist/scripts/backup.js
sudo -u kig git pull
sudo -u kig pnpm install --frozen-lockfile
sudo -u kig pnpm build
sudo systemctl restart kig-photo-space
curl -s https://photos.example.com/healthz
```

数据库迁移在启动时自动执行；迁移前会尝试 `VACUUM INTO data/backups/pre-migrate-<version>.sqlite`。迁移失败会回滚并拒绝启动。

## 8. 资源限制

- Node `--max-old-space-size=256`。
- systemd `MemoryMax=512M`、`CPUQuota=80%`。
- 上传并发 2；登录 scrypt 串行。
- SQLite `cache_size=-4000`（约 4MB）。
- 服务器不做任何图片编解码。

## 9. 反向代理注意事项

- 必须把 `X-Forwarded-For` / `X-Forwarded-Proto` 传给应用，并设置 `TRUST_PROXY=true`。
- `client_max_body_size` 至少 60MB（全图上限 50MB + multipart 开销）。
- 不要对 `/m/` 下的 AVIF 做运行时压缩；应用已发送 `immutable` 缓存头。
- 如果让 Nginx 直接服务 `/assets/`，请保留应用的 `Content-Type` 和缓存头，或按示例配置。
