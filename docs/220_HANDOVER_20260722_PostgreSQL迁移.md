# 220_HANDOVER_20260722_PostgreSQL迁移

## 任务类型
feature / migration / test / docs

## 所属主线
[215_PLAN_20260722_PostgreSQL迁移](./215_PLAN_20260722_PostgreSQL迁移.md)

## 为什么做
将主数据从 SQLite 等价迁移到 PostgreSQL，解决多进程并发和流式事件写入可靠性问题。

## 修改内容

- Prisma datasource 支为 PostgreSQL，移除 SQLite PRAGMA 初始化及唯一调用点。
- 新增 PostgreSQL baseline；保留旧 SQLite migrations 并在空 PostgreSQL 首次建库时标记为 applied。
- 新增一次性迁移和全表哈希/外键核验命令，不新增依赖。
- 新增基线报告与生产切换/回滚 runbook。

## 验证结果

- `prisma validate/generate`、`tsc --noEmit` 通过。
- SQLite 在线备份、SQLite 恢复、PostgreSQL migration、全量数据搬迁与核验通过。
- 26 张表行数/全行 SHA-256 一致，孤儿外键为 0。
- 3 并发写入方 300/300 条；清理后再次全量核验通过。
- 隔离 API smoke：Live Rooms 与 Tasks 均 200。
- PostgreSQL dump/restore 通过。
- `next build` 仍被迁移前已有的客户端 bundle 引入 Node `child_process` 错误阻塞。

## 生产切换结果

- 2026-07-22 已完成生产切换，切换前提交为 `a89accd`。
- 两个 `waiting_for_input` TaskRun 按维护窗口授权终止为 `failed`，其 pending interaction request 已取消。
- PostgreSQL 运行于独立 `postgres:16-alpine` 容器 `agent-platform-postgres`，监听 `127.0.0.1:55432`，使用持久卷 `agent-platform-postgres-data` 和 `unless-stopped` 重启策略。
- 最终迁移源共 26 张表；逐表行数、全行 SHA-256 和外键核验全部一致。关键表：`TaskRun=561`、`Message=5448`、`LiveRoomMessage=4711`、`TaskRunEvent=11044`。
- `agent-platform-dev.service` 与 `agent-platform-feishu.service` 已重启并确认使用 PostgreSQL；Live Rooms 与 Tasks API 均为 200，飞书长连接 healthy，SQLite 文件句柄为 0。
- 切换后 `pg_dump -Fc` 已成功恢复到临时数据库核验，再删除临时库。
- 备份位于 `/data1/backups/agent-platform/`：切换前 SQLite、最终迁移源 SQLite、切换后 PostgreSQL dump 各一份。

## 对主线的影响

Phase 0–4 已完成，生产主数据源已从 SQLite 切换到 PostgreSQL。当前保留 SQLite 备份作为 7 天观察期内的回滚点。

## 下一步建议

从真实飞书会话发送一条消息，确认回复、历史 transcript 和 continuation threadId；随后观察数据库错误、连接数和备份新鲜度。稳定运行至少 7 天后再决定是否清理 SQLite 备份。
