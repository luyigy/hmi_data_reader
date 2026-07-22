# 215_PLAN_20260722_PostgreSQL迁移

> 2026-07-22 状态：Phase 0–3 已完成隔离验证；Phase 4 等待生产维护窗口。证据见 [218_REPORT_20260722_PostgreSQL迁移基线](./218_REPORT_20260722_PostgreSQL迁移基线.md)，操作见 [219_GUIDE_20260722_PostgreSQL切换回滚](./219_GUIDE_20260722_PostgreSQL切换回滚.md)，交接见 [220_HANDOVER_20260722_PostgreSQL迁移](./220_HANDOVER_20260722_PostgreSQL迁移.md)。

## 目标

把 Agent Platform 的主数据从本机 SQLite 迁移到 PostgreSQL，改善多 Agent 并发、流式事件写入、多个服务进程共享数据库时的可靠性；保持现有 Prisma 数据模型和业务行为不变。

当前 SQLite 数据库约 26 MB，迁移原因是并发与运维能力，不是容量。现有数据入口为 `DATABASE_URL=file:./dev.db`，主要会话数据包括：

- `LiveRoomMessage`：Live Room 用户、Agent、系统、工具和最终消息。
- `Message`：Task Room transcript；后续 Agent prompt 从这里重建上下文。
- `TaskRunEvent`、`TaskRunParticipant`：stdout/stderr、运行状态、结果与错误。
- `LiveRoomMemberSession`、`TaskSession`：会话和 continuation 标识。
- `FeishuConversationBinding`、`LiveRoomDelivery`：飞书会话映射和投递状态。

Codex 原生 session JSONL 位于 `/data1/.agent-platform/codex-rooms/<room-id>/sessions`，本计划不迁入 PostgreSQL；数据库只保留其 thread/session 引用。

## 原则

1. 不同时重构业务模块；先做等价数据库迁移。
2. 不设计双写框架。停写、导出、导入、核验、切换足以覆盖当前单节点部署。
3. SQLite 备份保留到 PostgreSQL 稳定运行至少 7 天。
4. 所有时间、外键、唯一约束、级联删除和消息顺序必须核验，不能只比较总行数。
5. 生产切换必须有明确维护窗口和一条命令可执行的回滚路径。

## Phase 0：盘点与基线

- 记录 SQLite 文件、WAL 文件、Prisma/Node 版本和当前 `DATABASE_URL`。
- 按表导出行数、最大/最小 `createdAt`、空值和孤儿外键基线。
- 列出写入热点：`Message`、`LiveRoomMessage`、`TaskRunEvent`、`TaskRunParticipant`。
- 确认所有运行中的 TaskRun 已结束，或在维护窗口开始时明确中止。
- 创建可恢复备份，并实际执行一次 SQLite 恢复演练。

验收：有带时间戳的基线报告和可打开的 SQLite 备份。

## Phase 1：PostgreSQL Schema

- 新建独立 PostgreSQL 数据库和最小权限应用账号。
- 将 Prisma datasource provider 从 `sqlite` 改为 `postgresql`，仍由 `DATABASE_URL` 注入。
- 用 Prisma migration 生成 PostgreSQL schema，不手写两套 ORM 模型。
- 检查 SQLite/PostgreSQL 差异：DateTime、Boolean、默认值、索引名、唯一约束、级联行为。
- 保持现有 JSON 字符串列为 `String/Text`；JSONB 优化另立任务，避免迁移时改变读写契约。

验收：空 PostgreSQL 数据库能通过 Prisma migration、generate、类型检查和应用启动 smoke。

## Phase 2：一次性数据搬迁工具

- 优先使用 PostgreSQL/SQLite 官方导出导入能力或已有 CLI；仅在类型转换无法满足时写一个一次性脚本。
- 按外键依赖顺序导入，保留所有现有 cuid 主键和时间戳。
- 大表分批插入；每批事务提交，失败可从空库重来，不实现通用同步框架。
- 导入后重新核验每表行数、关键字段哈希/抽样、孤儿外键、最新会话和最近消息顺序。

最低必查场景：

- 一个包含多 Agent 的 Live Room 完整 transcript。
- 一个有 stdout/stderr/tool/final 事件的 TaskRun。
- 一个有 continuation threadId 的 Codex session。
- 一个飞书绑定及其最近投递记录。

验收：自动核验无差异，人工打开历史房间能看到完整消息。

## Phase 3：预生产验证

- 用迁移后的副本启动一套隔离实例，不连接真实飞书写入口。
- 执行 Prisma 查询、API smoke、Task Room prompt 重建和 Live Room transcript 读取。
- 并发运行至少 3 个本地 harness，确认流式事件写入无 `database is locked`、无顺序错乱。
- 验证失败、取消、服务重启后的 TaskRun 状态收敛。
- 建立 PostgreSQL 备份、恢复、连接池和磁盘告警。

验收：类型检查、相关测试、并发 smoke、备份恢复全部通过。

## Phase 4：生产切换

1. 宣布维护窗口并停止 Feishu runtime/应用写入。
2. 确认没有运行中的 Agent 子进程。
3. 对 SQLite 做最终 checkpoint 和只读备份。
4. 清空目标 PostgreSQL，执行最终导入与核验。
5. 更新服务端 `DATABASE_URL`，运行 Prisma migration/generate。
6. 启动应用与 Feishu runtime，检查健康状态和错误日志。
7. 从飞书发送一条消息，完成一次 Codex 回复，并读取历史 transcript。

验收：新旧基线一致，新消息只写入 PostgreSQL，最终回复和 continuation 正常。

## 回滚

- 触发条件：数据核验失败、核心 API 不可用、消息丢失/乱序、持续数据库错误。
- 立即停止所有写入，保存 PostgreSQL 故障现场。
- 将 `DATABASE_URL` 恢复为维护窗口生成的最终 SQLite 备份并重启服务。
- PostgreSQL 切换后的新写入若需回灌，必须先形成单独恢复方案，禁止直接手工拼库。

## 不在本计划内

- JSON 字符串列批量改为 JSONB。
- 读写分离、分库分表、事件总线和双写。
- Codex/Claude 自身 session 文件入库。
- 同时拆分大型业务文件；见 [216_PLAN_20260722_功能内聚重构](./216_PLAN_20260722_功能内聚重构.md)。

## 交付物

- Prisma PostgreSQL migration。
- 一次性迁移/核验命令及运行记录。
- 生产切换与回滚 runbook。
- 迁移完成 HANDOVER，包含表级核验结果和真实飞书 smoke。
