---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · LiveRoom执行超时配置与超时不重试交付

## 完成内容

1. **房间级执行超时数据模型**：`LiveRoom` 新增可空 `executionTimeoutMs`（毫秒），migration
   `20260817120000_add_live_room_execution_timeout` 已在开发库应用并通过 `prisma generate`。
   `null` 表示沿用现有 backend 默认（远程 SSH / Remote Runner 10 分钟、Platform Local
   codex/claude/kimi-code 不限时、其他本地 harness 24 小时）。
2. **超时配置入口**：新增共享模块 `src/lib/live-room-execution-timeout.ts` 统一校验
   （1–1440 整数分钟，拒绝 NaN/负数/小数/越界，`inherit` 恢复默认）、毫秒转换、watchdog 解析与
   回收阈值计算。飞书房间创建/配置卡新增“执行超时（分钟，可选）”输入并映射为
   `/ap room --timeout=<分钟>`；新增 `/ap timeout <分钟>|inherit` 短路径；两个入口复用同一
   `applyLiveRoomExecutionTimeoutUpdate`（写库 + `execution_timeout_changed` 系统消息），
   `/ap room` 结果回显最终分钟数，非法值在任何写操作前被拒绝。
3. **执行链注入**：`runLiveRoomAcpxAttempt` 经 `resolveLiveRoomExecutionWatchdogConfig` 读取
   房间显式配置写入 `watchdogConfig.maxRuntimeMs`；Remote SSH 与 Remote Runner 共享同一解析
   结果（`runner-harness.ts` 的远程默认值改由该模块导出，单一事实源）。无显式配置时不覆盖
   任何现有默认。
4. **超时不重试、不标 stale**：删除 Live Room 对通用 `timed out after \d+ms` 的 fresh-session
   fallback；codex adapter 的 continuation-invalid 模式移除 `timed out after \d+ms` 与
   `timeout waiting for child process to exit` 两条墙钟模式。超时后的房间系统提示明确写
   “本次回复执行超时”，不再出现“续聊会话失效”；真正的 session/thread 失效信号仍只重试一次。
5. **回收阈值跟随房间超时**：`live-room-delivery-processing.ts` 的远程 delivery 回收与
   `feishu-runtime-cleanup.ts` 的 running-delivery watchdog 均改为“所属房间有效执行超时 + 宽限
   （远程 30s / watchdog 2min）”，未配置房间保持原 10m30s / 12m 行为；仍有注册进程的运行不再
   仅因超过旧 10/12 分钟阈值被回收。

## 修改文件

- `prisma/schema.prisma`、`prisma/migrations/20260817120000_add_live_room_execution_timeout/migration.sql`
- `src/lib/live-room-execution-timeout.ts`（新增）
- `src/lib/live-room-delivery-routing.ts`（`DeliveryRoom.executionTimeoutMs`）
- `src/lib/live-room-delivery-execution.ts`
- `src/lib/live-room-delivery-processing.ts`
- `src/lib/feishu-runtime-cleanup.ts`
- `src/lib/acpx/runner-harness.ts`
- `src/lib/harness/adapters/codex.ts`
- `src/lib/feishu-command-parser.ts`、`src/lib/feishu.ts`、`src/lib/feishu-help.ts`、`src/lib/feishu-live-room-commands.ts`
- `tests/live-room-execution-timeout.test.ts`（新增）、`tests/feishu-room-timeout-command.test.ts`（新增）、`tests/live-room-handoff-boundaries.test.ts`
- `package.json`（新增 `test:live-room-execution-timeout`、`test:feishu-room-timeout`）

## 验证

- `npm run test:live-room-execution-timeout`：null 保持远程 10 分钟默认；显式 30/60/90 分钟同时
  传到 remote ssh / remote runner / platform local 的 watchdog；越界与小数被拒绝；30 分钟房间在
  10m30s/12m 不被回收、超过“配置值 + grace”才回收；`timed out after 600000ms`（Codex/Remote
  SSH/Remote Runner/Pi Agent/Claude 文案）不再判为 invalid continuation，session-not-found 等
  明确信号仍判失效。
- `npm run test:feishu-room-timeout`：`/ap timeout 30|inherit|0.5|1441` 解析与 handler 行为、
  `/ap room --timeout=45`、创建卡“执行超时”输入、表单映射、帮助文案、两入口复用同一更新函数
  （patched prisma 验证写库与 `execution_timeout_changed` 系统事件）。
- `tests/live-room-handoff-boundaries.test.ts`：更新为断言“仅显式会话失效信号触发一次 fresh
  重试；墙钟超时不触发”。
- 回归：live-room-handoff / handoff-plan / workflows / permissions / scheduling /
  directed-protocol / process-registry、feishu-mode/help/room-controls/live-room-initialization/
  relay/members、codex-member-settings、new-session-rotation、acpx-session-tracking、
  remote-runner-executor、feishu-progress-system-info、feishu-runtime-recovery、
  `npm run test:acpx-harness-options`、`npm run test:workflow-validator` 全部通过。
- `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check` 通过。
- `npx prisma migrate status`：32 migrations，schema up to date。

## 遗留事项

- S02（Remote Runner Gateway systemd 安装与 runner 连接诊断）与 S03（Dashboard Agent 契约与
  RemoteNode 可见性）未开始。
- 真机（shaw-pi / Windows runner）上的长超时实测待 S02 Runner 连通后一并验收。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/445_HANDOVER_20260817_LiveRoom执行超时配置与超时不重试交付.md`、`docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S02。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
