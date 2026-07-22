# 219_GUIDE_20260722_PostgreSQL切换回滚

## 前提

- 先提交并部署本迁移代码，记录迁移前 SQLite 版本 Git ref 为 `PRE_MIGRATION_REF`。
- 目标 PostgreSQL 必须是空数据库；应用账号只拥有独立数据库，不给集群级权限。
- 维护窗口内停止 Web 与 Feishu runtime，确认无 Agent 子进程和 `running/waiting_for_input` TaskRun。
- SQLite 备份至少保留 7 天。真实密码只放服务环境文件，不写入仓库或命令历史。

## 建库（以 PostgreSQL 管理员执行）

当前生产实例使用独立容器：`postgres:16-alpine`、容器名 `agent-platform-postgres`、持久卷 `agent-platform-postgres-data`，仅绑定 `127.0.0.1:55432`。宿主机 `5432` 已被其他服务占用。

```sql
CREATE ROLE agent_platform LOGIN PASSWORD '<strong-random-password>';
CREATE DATABASE agent_platform OWNER agent_platform;
REVOKE ALL ON DATABASE agent_platform FROM PUBLIC;
```

应用连接示例：

```text
postgresql://agent_platform:<password>@127.0.0.1:55432/agent_platform?schema=public&connection_limit=10&pool_timeout=10
```

## 生产切换

```bash
systemctl --user stop agent-platform-feishu.service agent-platform-dev.service
pgrep -af 'codex|claude|antigravity|acpx'
sqlite3 prisma/dev.db "SELECT status, COUNT(*) FROM TaskRun WHERE status IN ('running','waiting_for_input') GROUP BY status;"
sqlite3 prisma/dev.db 'PRAGMA wal_checkpoint(TRUNCATE);'
sqlite3 prisma/dev.db ".backup 'prisma/dev.db.pre-postgresql-final-YYYYMMDD-HHMMSS'"
sqlite3 prisma/dev.db.pre-postgresql-final-YYYYMMDD-HHMMSS 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

只有 `pgrep` 无真实 Agent 子进程、TaskRun 查询为空、完整性为 `ok` 且无外键输出时继续：

```bash
export DATABASE_URL='postgresql://agent_platform:<password>@127.0.0.1:55432/agent_platform?schema=public&connection_limit=10&pool_timeout=10'
scripts/bootstrap-postgresql.sh
npm run db:migrate:sqlite -- prisma/dev.db.pre-postgresql-final-YYYYMMDD-HHMMSS
npm run db:verify:migration -- prisma/dev.db.pre-postgresql-final-YYYYMMDD-HHMMSS
docker exec agent-platform-postgres pg_dump -U agent_platform -d agent_platform -Fc > /secure-backup/agent-platform-post-cutover.dump
```

把两个 systemd 服务使用的 `DATABASE_URL` 更新为同一个 PostgreSQL URL 后：

```bash
systemctl --user daemon-reload
systemctl --user start agent-platform-dev.service agent-platform-feishu.service
curl -fsS http://127.0.0.1:3010/api/live-rooms >/dev/null
curl -fsS http://127.0.0.1:3010/api/tasks >/dev/null
journalctl --user -u agent-platform-dev.service -u agent-platform-feishu.service -n 200 --no-pager
```

最后从飞书发送一条消息，确认历史 transcript、Codex 最终回复和 continuation threadId 正常，并确认新消息只出现在 PostgreSQL。

## 备份与监控

- 每日至少一次容器内同版本 `pg_dump -Fc`，异机保留；每次发布前做一次，并定期恢复到临时数据库核验。宿主机 `pg_dump` 14 不能备份 PostgreSQL 16，且 Prisma URL 参数不能直接传给 `pg_dump`。
- 监控 `pg_database_size('agent_platform')`、主机磁盘、连接数、长事务和备份新鲜度。
- 当前单节点先使用 Prisma `connection_limit=10`；多进程连接总数接近 PostgreSQL `max_connections` 时再引入 PgBouncer。

## 回滚

触发条件：校验差异、核心 API 不可用、消息丢失/乱序或持续数据库错误。

```bash
systemctl --user stop agent-platform-feishu.service agent-platform-dev.service
docker exec agent-platform-postgres pg_dump -U agent_platform -d agent_platform -Fc > /secure-backup/agent-platform-failed-cutover.dump
git switch --detach "$PRE_MIGRATION_REF"
export DATABASE_URL='file:/absolute/path/prisma/dev.db.pre-postgresql-final-YYYYMMDD-HHMMSS'
npm ci
npx prisma generate
systemctl --user start agent-platform-dev.service agent-platform-feishu.service
```

回滚必须同时恢复迁移前代码/SQLite provider 和最终 SQLite 快照；当前 PostgreSQL provider 不能直接接受 `file:` URL。切换后的 PostgreSQL 新写入不得手工拼回 SQLite，需另立恢复方案。
