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

## 对主线的影响

Phase 0–3 的代码和隔离验证已完成。Phase 4 未执行：当前仍有活动 TaskRun，且没有获批生产维护窗口/真实 PostgreSQL 凭据。

## 下一步建议

按 [219_GUIDE_20260722_PostgreSQL切换回滚](./219_GUIDE_20260722_PostgreSQL切换回滚.md) 预约维护窗口，生成最终快照、执行生产迁移和真实飞书 smoke。SQLite 备份稳定运行至少 7 天后再清理。
