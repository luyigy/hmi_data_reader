# 218_REPORT_20260722_PostgreSQL迁移基线

## 基线时间与环境

- 快照时间：2026-07-22 15:32:05 CST
- SQLite：`prisma/dev.db`，27,172,864 bytes（在线 backup 后大小）
- 一致性快照：`prisma/dev.db.pre-postgresql-20260722-153205`（被 `.gitignore` 排除）
- Node.js：v22.22.1
- Prisma CLI / Client：5.22.0 / 5.22.0
- PostgreSQL 验证环境：16-alpine，隔离容器端口 55432
- 原始运行状态：`completed=509`、`failed=45`、`running=1`、`waiting_for_input=2`

当前仍有活动 TaskRun，因此该快照只用于预生产验证，不能作为生产最终切换快照。

## SQLite 备份恢复演练

- 使用 SQLite `.backup` 在线生成一致性快照。
- 将快照复制为 `/tmp/agent-platform-sqlite-restore-check.db` 后重新打开。
- `PRAGMA integrity_check`：`ok`
- `PRAGMA foreign_key_check`：0 行

## 表级基线

| 表 | 行数 | 表 | 行数 |
| --- | ---: | --- | ---: |
| Agent | 31 | ChatRoom | 21 |
| ControlPlaneState | 0 | CrossGatewayChatMessage | 16 |
| CrossGatewayChatSession | 2 | FeishuAdminApproval | 1 |
| FeishuConversationBinding | 7 | FeishuUserAccess | 1 |
| Gateway | 6 | GatewayMessage | 3 |
| IncomingGatewayMessage | 0 | LiveRoom | 17 |
| LiveRoomDelivery | 509 | LiveRoomMember | 51 |
| LiveRoomMemberSession | 24 | LiveRoomMessage | 4,680 |
| Message | 5,417 | RemoteHarnessHost | 2 |
| Task | 19 | TaskRun | 557 |
| TaskRunControlMessage | 44 | TaskRunEvent | 10,652 |
| TaskRunInteractionRequest | 107 | TaskRunParticipant | 576 |
| TaskSession | 98 | _AgentToTask | 0 |

写入热点非空/孤儿基线：`Message`、`LiveRoomMessage`、`TaskRunEvent`、`TaskRunParticipant` 的必填关键列空值均为 0，直接父表孤儿均为 0。

| 热点表 | 最早 createdAt (UTC) | 最晚 createdAt (UTC) |
| --- | --- | --- |
| Message | 2026-03-09 15:18:31 | 2026-07-22 07:31:58 |
| LiveRoomMessage | 2026-03-25 10:52:44 | 2026-07-22 07:31:57 |
| TaskRunEvent | 2026-03-23 06:54:17 | 2026-07-22 07:31:59 |
| TaskRunParticipant | 2026-03-23 06:54:17 | 2026-07-22 07:30:30 |

## 隔离迁移结果

- 26 张业务/关联表行数全部一致。
- 26 张表按主键排序后的全行 SHA-256 全部一致。
- PostgreSQL 外键孤儿总数：0。
- 关键数据：`LiveRoomMessage=4680`、`Message=5417`、`TaskRunEvent=10652`。
- 3 个并发写入方共写入 300/300 条，清理后全量哈希仍一致。
- 隔离 API：`GET /api/live-rooms` 200，读到 17 个房间；`GET /api/tasks` 200，读到 19 个任务。
- PostgreSQL `pg_dump -Fc`：3,834,172 bytes；恢复到新数据库后关键表行数一致。

完整逐表 SHA-256 由 `npm run db:verify:migration -- <sqlite-snapshot>` 可重复生成，避免在文档里维护易过期的哈希副本。
