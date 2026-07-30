---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/319_PLAN_20260730_定时任务与Workflow重启恢复闭环.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · Workflow 重启恢复 S02 交接

## 完成内容

- Workflow PLAN 审批在既有 cursor `pending` 中记录 `reviewAttempt`；未过期重试复用同一轮次幂等键，
  过期后关闭旧卡并创建新 expiry、attempt 和卡片幂等键。
- 审批卡回调携带 attempt；只有当前 attempt、当前 message id、有效期内且仍为 review 的决定可落库。
  既有 PostgreSQL advisory transaction lock 保证并发回调只有一个进入终态。
- `WorkflowDispatch` 在无法确认 Feishu 卡片是否已发送的窗口先持久化 `blocked`；session reset、
  live-room prompt 和 reply queue 继续通过已有数据库 checkpoint 自动续跑，不重复成功副作用。
- 新增聚焦故障注入，覆盖 session reset、Feishu post、prompt post、reply queue 各 checkpoint，
  以及审批旧卡、cursor 保存前后、旧/重复/并发回调。

## 验证结果

- `tests/workflow-watcher.test.ts`：通过。
- `tests/workflow-review-concurrency.test.ts`：通过。
- `tests/workflow-dispatch-recovery.test.ts`：通过。
- S02 文件定向 ESLint：通过。
- HEAD + S02 精确隔离工作树 `npx tsc --noEmit --incremental false`：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- `git diff --check`：通过。
- GitNexus 强制 compare（base `master`）已运行；因包含当前分支累计历史与共享工作区改动，报告
  229 files / CRITICAL。补充 staged 检查聚焦到 Workflow 审批、投递和 Feishu 回调链路，报告 HIGH；
  精确暂存 diff 已复核，其他用户改动未纳入本 Slice 提交。

## 边界

- 未开始 S03，未改变 S01 scheduled-job runner 收口。
- 未新增 heartbeat、lease、outbox、状态卡片、数据库表或 migration。
- 未重启服务，未发送真实 Feishu 消息。
- 开工前所有用户改动均保留且不纳入本 Slice 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/319_PLAN_20260730_定时任务与Workflow重启恢复闭环.md` 的 S03：只完成恢复链路集成验证与终态
交接。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/320_HANDOVER_20260730_定时任务重启恢复S01交接.md`、
`docs/321_HANDOVER_20260730_Workflow重启恢复S02交接.md`，以及 S01/S02 实现和聚焦测试；保留开工前
工作区所有用户改动。对实际修改的每个 function/class/method 先运行 GitNexus upstream impact，
HIGH/CRITICAL 必须先报告。不得新增 heartbeat、lease、outbox、状态卡片或数据库表；不得改写 Git
历史、猜测外部副作用、重启真实服务或发送真实 Feishu 消息。使用隔离数据库和 fake sender 验证
runner 执行中重启、Workflow 审批/dispatch checkpoint 重启、重复 watcher、并发审批、60 秒 timeout、
Git 历史分叉和服务停止。完成相关测试、TypeScript、ESLint、`npm run check:long-files`、
`git diff --check` 和 GitNexus `detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，
创建 `plan_progress: complete`、`next_action: await_acceptance` 的 S03 HANDOVER，并立即停止。
<!-- WORKFLOW_PROMPT_END -->
