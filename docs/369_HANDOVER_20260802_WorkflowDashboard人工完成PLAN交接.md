---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S08
plan_progress: in_progress
---

# HANDOVER · Workflow Dashboard 人工完成 PLAN 交接

## 完成内容

- Workflow Dashboard 在 watcher 空闲、无 pending 且存在未完成 PLAN 时，新增“人工标记所选 PLAN 完成”选择框和确认按钮。
- 人工操作只允许平台管理员或项目审批人执行；回调会再次校验所选 PLAN、Dashboard HEAD、目标 branch、运行状态和 clean worktree。
- 成功时把目标 PLAN 提交为 `doc_status: completed`、`next_action: await_acceptance`；若原 action 可执行则按目标 HEAD 的 workflow contract 删除自动化 Prompt，原 action 不可执行且本就没有 Prompt 时直接完成；重复操作保持幂等。
- “校验所选 PLAN / HANDOVER”按钮改为蓝底白字主按钮。
- 实现提交：`cca9838 feat(workflow): allow manual plan completion`。

## 现场诊断

- `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 仍为 `ready / start_first_slice`，因此未完成 PLAN 警告属实。
- 用户在 2026-08-02 08:16 点击人工完成后，服务日志明确返回“目标工作区非 clean，拒绝标记完成”；当时 dirty 来源是尚未提交的本次功能改动，因此没有产生 PLAN 完成提交。
- 工作区 clean 后再次操作进入 Git hook，但原实现只改 frontmatter、保留了 `start_first_slice` 对应的 Prompt；`await_acceptance` 是 terminal action，Validator 因此以 `PROMPT_FORBIDDEN` 拒绝提交并自动恢复 PLAN。
- 第一轮根因已在共享转换函数修复：从目标 HEAD 读取该 watcher 的 contract，在转换 terminal 状态时删除已有 Prompt 块；不针对 `333_PLAN` 写特例。
- 333 完成并产生提交 `e807346` 后，330 再次失败。330 是合法的 `draft / await_plan_approval`，按合同本就不得携带 Prompt；第一轮修复错误地把“一对 Prompt”设成所有未完成 PLAN 的前置条件。现改为允许零对、存在一对时删除，错配或多对仍拒绝。
- `agent-platform-feishu.service` 已于 2026-08-02 08:15:43 重启并加载新代码；失败与服务未重启无关。
- 卡片先显示“操作已接收”，随后才异步回复实际成功或失败结果；不能把前者视为完成证据。

## 验证

- `npm run test:workflow-plan-completion`：通过，覆盖有 Prompt 的可执行 PLAN 与无 Prompt 的待审批 PLAN、完成后真实 Validator 复验、成功提交、幂等和过期 HEAD。
- `npm run test:workflow-validator`：通过。
- `tests/feishu-job-command.test.ts`：通过，覆盖人工完成表单、动作和值透传。
- `npx tsc --noEmit`：通过。
- 修改文件定向 ESLint、`npm run check:long-files` 和 `git diff --check`：通过。
- 全仓 `npm run lint` 仍被既有、与本次无关的 agents/control-plane/gateway 及生成文件错误阻断。
- GitNexus 刷新后确认 `completeWorkflowPlan` upstream 风险为 HIGH：2 个直接调用者、2 条受影响流程、4 个模块；生产侧唯一直接调用者是 Dashboard 回调，间接到飞书卡片处理链。`detect_changes(scope: all)` 识别 3 个代码文件、5 个符号和 7 条 Dashboard 流程，均属预期范围。

## 当前状态与下一步

- S08 的真实用户侧 Feishu E2E 仍未完成，本 HANDOVER 保持 `plan_progress: in_progress`、`next_action: blocked`；本次功能不自动宣称 S08 完成。
- 本交接提交后需重启飞书服务以加载修复，再重新发送或刷新 Dashboard，确认卡片 HEAD 为最新提交，然后选择 `330_PLAN` 点击人工完成。
- 成功回复必须包含新 HEAD，随后刷新 Dashboard；此时未完成 PLAN 和 Git dirty 警告应同时消失。

## 非自动化恢复提示

blocked HANDOVER 不包含 workflow Prompt 标记。恢复真实 S08 验收时读取本 HANDOVER、原 PLAN、workflow contract 和目标 HEAD 的 `AGENTS.md`；若选择人工收口，只执行上述 Dashboard 操作，不由 Agent 直接改写 PLAN。
