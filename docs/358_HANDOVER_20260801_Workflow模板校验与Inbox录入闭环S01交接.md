---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow 模板、校验修复与 Inbox 录入闭环 S01

## 完成内容

- 在目标仓库加入 `docs/workflow/templates/PLAN.md` 与 `HANDOVER.md` 权威模板，覆盖 phase、interrupt、
  next_slice、resume_parent 和 await_acceptance 最小合法片段；合同和 Agent/自动化指南显式声明路径。
- 合同加入 `balanced / strict` 模式。Validator 为每条诊断返回稳定 code、error/warning severity、位置、
  期望/实际值和短模板片段，同时保留原错误类、文本 message、action/prompt 返回兼容。
- balanced 仅将六项既有策略规则降为 warning；结构、动作、引用和 Prompt 安全错误继续阻断。
- CLI 与 hook-batch 输出 warning；缺少目标模板时返回 `TEMPLATE_MISSING`，不回退平台隐藏模板。
- 将 349 未纳入本 PLAN 的网页登录认证/RBAC 原始需求拆到
  `docs/inbox/357_ISSUE_20260801_网页平台登录认证与RBAC.md`，保持 draft/none。

## 验证

- `npm run test:workflow-validator`
- `npm run test:workflow-watcher`
- `npm run test:workflow-roadmap-inbox`
- `npm run test:workflow-completion-gate`
- `npm run test:git-history-guard`
- `npx tsc --noEmit --pretty false`
- `npx eslint src/lib/scheduled-jobs/workflow-validator.ts scripts/validate-workflow-documents.ts tests/workflow-validator.test.ts`
- `npm run check:long-files`
- `git diff --check`

模板回归从权威文件实例化五种状态转换并在 strict 模式下以零 issue 通过。balanced/strict 使用同一非法
HANDOVER 验证 warning/error 分级，另有结构错误在 balanced 下继续 fail-closed 的回归。

## 边界与工作区

- 未开始 S02 的 guard bundle、自包含运行产物或沙箱安装改造。
- 未开始 S03/S04 的校验控制面、repair 或 Inbox 命令。
- 开工前已有的 workflow status/UI 改动仍保留在工作区，不纳入本 Slice 提交。
- 349 按计划保持 draft；待 S04 收口时再标记 superseded 并引用 357 与 352。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md` 的 S02：先读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml`、`docs/358_HANDOVER_20260801_Workflow模板校验与Inbox录入闭环S01交接.md`、
本 PLAN 与 `docs/inbox/347_ISSUE_20260731_WorkflowValidator沙箱绝对路径依赖.md`。保护所有开工前用户改动，
只完成 S02：把普通 Node.js 可直接运行的 Validator 产物安装到目标仓库 Git dir 的 `agent-platform/`，使 hook
不再依赖 Agent Platform 绝对路径、ts-node 或平台 node_modules；保持文档错误 fail-closed、运行环境故障
fail-open，不扩大 Bubblewrap 挂载、不修改 HMI Reader。修改任一 function/class/method 前运行 GitNexus
upstream impact，完成隔离仓库聚焦测试、TypeScript、定向 ESLint、长文件检查、diff check 与 GitNexus
detect_changes 后精确提交，并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S02 HANDOVER；
提交后停止。当前 Slice：S02。
<!-- WORKFLOW_PROMPT_END -->
