---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md
slice: S04
plan_progress: in_progress
---

# HANDOVER · Feishu 命令入口长文件 S04 交接

## 完成内容

- `src/lib/feishu.ts` 从 1454 行降至 130 行，仅保留兼容导出、Full Access 审批前置检查和
  `handleFeishuCommand` 薄路由。
- 按既有命令域提取运行状态与 Gateway/Agent/Host、Live Room 成员与模式、task/chat/grant/rights/
  approval/workspace；3 个新增源码分别为 373、419、585 行。
- 30 个既有函数体经 TypeScript AST 逐一核对完全一致；Webhook 与长连接继续调用同一
  `handleFeishuCommand`，解析、权限检查、审批和回复语义未改。
- 未修改 ACPX runner、Live Room delivery、`live-room.ts`、Codex telemetry、服务或生产数据。

## 验证

- 全部现有 `tests/feishu-*.test.ts` 聚焦测试通过。
- `npx tsc --noEmit`。
- 相关 ESLint：0 error、0 warning。
- `npm run check:long-files`：Feishu 已从历史超限清单移除；ACPX runner 与 `live-room.ts` 未增长。
- `git diff --check`。
- GitNexus isolated staged `detect_changes`：`No changes detected`；本次为原函数体不变的纯搬移，新文件
  不在目标 HEAD 索引中。
- GitNexus upstream impact：facade 2 个直接调用者，风险 LOW；共同覆盖 Webhook `POST` 与长连接
  `im.message.receive_v1` 的 11 条执行流。索引落后当前 HEAD 6 个提交，函数位置仍指向拆分前文件，
  因此以 TypeScript AST、聚焦测试和类型检查作为本次纯搬移的主要验证证据。

## 工作区保护

开工前已有的 `AGENTS.md`、`CLAUDE.md`、`.codex-tmp/`，以及执行期间新增的
`docs/301_HANDOVER_20260729_WorkflowCodexGit权限修复交接.md` 未修改，不纳入 S04 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S05：只纯拆分
`src/lib/acpx/runner.ts`。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/302_HANDOVER_20260729_Feishu命令入口长文件S04交接.md`、ACPX runner 入口及其直接依赖和现有
聚焦测试；确认并保护开工前用户的未提交改动，运行 `npm run check:long-files`。对将修改的每个 symbol
先运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。从 runner 提取 harness 执行生命周期、
participant/TaskRun metadata 持久化、continuation/恢复、终止与错误归一化等既有职责；保留当前公共
入口和事务边界，不加入 telemetry，不改变 Codex/Claude/其他 Harness 的新运行、续跑、停止、权限和
结果持久化语义。原文件和新增文件均须低于 800 行。不得开始 S06 或其他 Slice，不修改 Feishu 命令、
Live Room delivery、`live-room.ts`、Codex telemetry、服务或生产数据。完成聚焦测试、TypeScript、
相关 ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S05 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
