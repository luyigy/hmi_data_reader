---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md
slice: S06
plan_progress: in_progress
---

# HANDOVER · Live Room 服务长文件 S06 交接

## 完成内容

- `src/lib/live-room.ts` 从 1678 行降至 4 行，仅保留兼容 re-export facade，现有调用方无需修改。
- 按既有职责提取类型与公共 payload、成员目录/序列化/权限/上下文水位/Task 读取模型、消息序列化与
  可见性/提及/事件、pending reply 读取模型；4 个新增源码分别为 214、724、625、122 行。
- 目标 HEAD 中 38 个既有函数和箭头函数的 TypeScript AST 函数体与拆分后逐一核对完全一致；公共出口、
  payload、权限过滤、Web/飞书/API 消费语义未改。
- 未加入 handoff、Codex telemetry 或 quota，未修改 Feishu 命令、Live Room delivery、ACPX runner、
  服务或生产数据。

## 验证

- Live Room workflow、process registry、permission、directed protocol、scheduling、Feishu relay、
  Feishu room initialization、Feishu Agent session command 共 8 项聚焦测试通过。
- `npx tsc --noEmit`。
- 相关 ESLint：0 error、0 warning。
- `npm run check:long-files`：无文件达到 1000 行；本 PLAN 的 6 个历史超限源码已全部移除。
- `git diff --check`。
- GitNexus `detect_changes(scope: all)`：LOW、0 个受影响流程；新文件尚未进入目标 HEAD 索引，函数体
  AST 核对、聚焦测试和类型检查作为纯搬移的主要验证证据。
- GitNexus upstream impact：`postLiveRoomMessage` 为 CRITICAL，23 个直接调用者、23 条流程；
  `resolveLiveRoomMessageMetadata` 为 CRITICAL，18 个直接调用者、20 条流程；
  `syncLiveRoomSourceTask` 为 CRITICAL，12 个直接调用者、20 条流程。其余成员、序列化、消息与读取
  模型函数覆盖 Web、飞书、Live Room delivery、Workflow 和 API，均通过 facade 保持原出口。

## 工作区保护

开工前已有的 `AGENTS.md`、`CLAUDE.md`、`.codex-tmp/`，以及执行期间并发出现并已暂存的
`docs/301_HANDOVER_20260729_WorkflowCodexGit权限修复交接.md` 未修改，不纳入 S06 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S07：只实现普通 Live Room
的受控异步 handoff。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/304_HANDOVER_20260729_LiveRoom服务长文件S06交接.md`、
`docs/290_ISSUE_20260728_AgentMention受控异步接力.md`、S03 拆分后的 Live Room delivery 边界、
房间成员/消息/TaskRun/Session/权限模型及现有聚焦测试；确认并保护开工前用户的未提交改动，运行
`npm run check:long-files`。对将修改的每个 symbol 先运行 GitNexus upstream impact，HIGH/CRITICAL
先报告。按 PLAN 已定语义解析 assistant reply 的单个 `$member` 意图，以 assistant reply 身份和根消息
预算做持久化幂等 claim；增加房间级 `handoffLimit`，新建和既有房间默认 4，根链创建时固定预算快照，
`0` 关闭自动 handoff；复用 `/ap room` 参数解析和房间管理权限，实现
`/ap room --handoff-limit=<N>` 与 `/ap handoff-limit <N>` 查询/修改。当前 delivery、TaskRun/
participant 必须先终态并释放成员锁，事务提交后下一 delivery 才可领取；复用原 Session continuation
和权限快照。`@member`、多目标、未知成员、结构化 Workflow、超限、stop、离线、超时、中断和恢复失败
严格按 PLAN 收敛，不扩大权限或新增第二套工作流引擎。不得开始 S08 或其他 Slice，不实现 Codex
App Server、telemetry 或 quota，不重启服务、不发送真实飞书消息、不修改生产数据。完成 Prisma/
迁移校验、A→B、A→B→A、重复 claim、预算/权限/终止恢复、Web/飞书一致性聚焦测试、TypeScript、
相关 ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S07 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
