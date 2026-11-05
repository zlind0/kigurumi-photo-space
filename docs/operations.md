# 运维

## 健康检查

```bash
curl -s http://127.0.0.1:3000/healthz
# {"ok":true,"db":true,"dataDir":true,"diskFree":...,"diskTotal":...}
```

`ok=false` 时检查：

- `db`：SQLite 文件是否可读、磁盘是否满。
- `dataDir`：`DATA_DIR` 是否可写。
- `diskFree`：低于 `MIN_FREE_BYTES` 时上传会返回 507。

## 备份

### 数据库

```bash
cd /opt/kig-photo-space
sudo -u kig env $(grep -v '^#' /etc/kig-photo-space.env | xargs) node dist/scripts/backup.js
```

输出 `DATA_DIR/backups/db-<timestamp>.sqlite`。`VACUUM INTO` 生成一致性副本，可在服务运行时执行。

### 文件

```bash
sudo rsync -a --delete /var/lib/kig-photo-space/ /backup/kig-photo-space/
```

建议顺序：先文件、后数据库；或使用 LVM/ZFS/btrfs 快照保证一致性。

### 保留策略

- 每日备份保留 7 天。
- 每周备份保留 4 周。
- 每季度做一次恢复演练。

## 恢复

```bash
sudo systemctl stop kig-photo-space
sudo rsync -a /backup/kig-photo-space/ /var/lib/kig-photo-space/
sudo chown -R kig:kig /var/lib/kig-photo-space
sudo systemctl start kig-photo-space
curl -s http://127.0.0.1:3000/healthz
```

恢复后抽查：首页封面、相册页、灯箱全图、私密相册权限。

## 回收站

删除相册会移动到 `DATA_DIR/.trash/<timestamp>-<dir>`，保留 `TRASH_RETENTION_DAYS`（默认 7 天）。

```bash
node dist/scripts/purge-trash.js
```

应用每天也会自动清理一次。

## 文件系统检查

```bash
node dist/scripts/fsck.js          # 只报告
node dist/scripts/fsck.js --fix    # 删除孤儿文件
```

报告两类问题：

- `MISSING`：数据库有记录但文件不存在（可能是磁盘故障/误删）。
- `ORPHAN`：文件存在但数据库没有记录（可能是上传中断/旧版本残留）。

`--fix` 只删除孤儿文件，不会删除数据库记录。缺失文件需要从备份恢复。

## 日志

```bash
journalctl -u kig-photo-space -f
journalctl -u kig-photo-space --since "1 hour ago"
```

应用日志不记录密码、cookie、token、完整 EXIF。审计日志在 SQLite 的 `audit_log` 表，管理台可查。

## 审计日志清理

应用每天按 `AUDIT_RETENTION_DAYS`（默认 180 天）清理。手动清理：

```bash
sqlite3 /var/lib/kig-photo-space/db.sqlite \
  "DELETE FROM audit_log WHERE ts < (strftime('%s','now') - 180*86400)*1000;"
```

## 磁盘配额

- `MAX_TOTAL_BYTES`：照片总占用上限（默认 20GB）。
- `MIN_FREE_BYTES`：磁盘剩余低于此值时拒绝上传（默认 1GB）。
- 单相册照片数 `MAX_PHOTOS_PER_ALBUM`（默认 5000）。
- 单用户相册数 `MAX_ALBUMS_PER_USER`（默认 200）。

管理台“统计”页显示照片数、总占用、磁盘剩余。

## 会话

- 滑动 7 天，绝对上限 30 天。
- 每小时清理过期 session。
- 管理员重置密码/禁用用户会删除该用户所有 session。

## 常见问题

### 上传返回 507

磁盘剩余低于 `MIN_FREE_BYTES` 或总占用超过 `MAX_TOTAL_BYTES`。清理回收站/旧照片，或调整配置。

### 上传返回 422 INVALID_THUMBNAIL

客户端生成的缩略图不是 600×600 8-bit 4:2:0 AVIF。通常是浏览器 wasm 加载失败或旧缓存；强制刷新页面后重试。

### 上传返回 422 INVALID_AVIF

AVIF 容器结构不合法（例如动画、iloc 越界、尾随字节）。让用户重新导出/重新上传。

### 登录 429

登录限流：每 IP 10 次/分钟、100 次/小时，全局 100 次/分钟。等待 `Retry-After`。

### 私密照片仍被公开访问

检查：

- 相册 `visibility` 是否为 `private`。
- 照片是否在 `hidden/` 目录。
- 公开相册的封面必须是公开照片（写入规则会拒绝私密封面）。
- Nginx/CDN 是否缓存了旧的公开响应；媒体 URL 带内容 MD5，私密化后 URL 会变化。
