---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/364_PLAN_20260801_WorkflowDashboard队列与文档按需查看.md
slice: S03
plan_progress: complete
---

# HANDOVER · Workflow Dashboard 终态 HANDOVER 文档可见性修复

## 问题与根因

- 科学试模助手项目的 `214_HANDOVER`、`215_HANDOVER` 已提交到绑定的 `dev` 分支，但未出现在飞书
  Workflow Dashboard 的“查看文档”下拉框中。
- `inspectWorkflowOverview` 先从 PLAN 列表排除已完成 PLAN，又用该列表二次过滤 HANDOVER；因此凡是关联已完成
  PLAN 的终态 HANDOVER 都被误删。Git 提交、项目绑定、分支和缓存均不是问题。

## 修复内容

- `src/lib/scheduled-jobs/workflow-inspection.ts`：移除 HANDOVER 必须关联“未完成 PLAN”的展示过滤，所有已提交且
  合法解析的 HANDOVER 均进入 `overview.handovers`。
- 未改动 PLAN 执行队列过滤、workflow cursor、审批、激活、自治模式或执行语义；本次只修复文档查看入口的可见性。
- `tests/feishu-job-command.test.ts`：将终态 HANDOVER 加入 overview 与格式化输出断言，防止后续再次被过滤。

## 验证与运行状态

- 定向回归、TypeScript 类型检查、`git diff --check` 和长文件守卫通过。
- 使用科学试模助手项目真实 `dev` HEAD 排查确认，`214_HANDOVER` 与 `215_HANDOVER` 均满足命名和 frontmatter
  契约；修复后的 Dashboard 会保留此类终态 HANDOVER。
- `agent-platform-feishu.service` 已于 2026-08-30 13:33:02 CST 重启，当前状态为 `active`。

## 验收与边界

在科学试模助手群重新打开 Workflow Dashboard，在“查看文档”中确认可选择 214、215 HANDOVER，并任选一项验证
飞书文档可正常打开。本 PLAN 保持终态等待人工验收，不启动新 Slice。
