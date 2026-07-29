---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Live Room Task Chat 长文件 S01 交接

## 完成内容

- `src/app/tasks/[id]/chat/page.tsx` 从 2455 行降至 311 行，只保留 controller 编排、页面状态入口和主布局。
- 按现有职责提取 Task Chat 类型与纯派生模型、状态与请求、Socket、控制动作、timeline/message rendering、
  composer/权限编辑/运行控制，以及 run history/participant inspector。
- 页面、所有新增源码均低于 800 行；请求 URL/body、Socket event、审批、权限、执行、续接和交互文案未改。
- 未修改 S02、长文件规则、handoff、Codex telemetry、服务或生产数据。

## 验证

- `npx tsc --noEmit`
- 相关 ESLint：0 error；保留与拆分前 effect 依赖数组语义一致的 5 条 `react-hooks/exhaustive-deps` warning
- `npm run check:long-files`：Task Chat 页面已从历史超限清单移除，其余 5 个历史文件未增长
- `git diff --check`
- GitNexus `detect_changes`：LOW，未发现受影响 execution flow
- `npm run build` 未通过：既有客户端依赖链
  `acpx/permissions -> harness registry -> real-agents` 引入 Node `child_process`；拆分前页面已直接导入同一
  permissions 模块，本 Slice 未扩大或修复该既有构建问题

## 工作区保护

开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改，不纳入 S01 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S02：只纯拆分
`src/components/live-room/LiveRoomWorkspace.tsx`。先读取目标 HEAD 的
`docs/workflow/workflow-contract.yaml`、本 PLAN、最新有效 HANDOVER、Live Room Workspace 及其直接
依赖和现有聚焦测试；确认并保护开工前用户的未提交改动，运行 `npm run check:long-files`。对将修改的
每个 symbol 先运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。按现有 feature 责任提取成员/运行
状态面板、消息时间线、composer/mention、房间控制和纯展示模型；Workspace 仅组合现有 hooks、状态和
布局。原文件和新增文件均须低于 800 行，Web Live Room 的 payload、轮询、Socket、权限、可见性、发送、
停止、审批和水位展示语义不变。不得开始 S03 或其他 Slice，不修改长文件规则、handoff、Codex telemetry、
服务或生产数据。完成聚焦测试、TypeScript、相关 ESLint、long-file guard、`git diff --check` 和
GitNexus `detect_changes` 后提交，并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S02
HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
