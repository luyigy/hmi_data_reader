---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 271_PLAN_20260728_工作流诊断与飞书操作导航.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · Feishu 帮助分页 S02

## 完成内容

- `/ap help [页码]` 与 `/ap help --page=<页码>` 已按房间与 Agent、运行控制、Workflow / Jobs、权限与管理分为四页，并显示页码及相邻页命令。
- 复用现有 parser 的 `args`/`options`；只替换帮助输出，不新增权限或动作注册表。

## 验证

- `tests/feishu-help-command.test.ts` 覆盖两种页码语法、边界页和主要命令可发现性并通过。
- `npx tsc --noEmit`、相关 ESLint、`git diff --check` 通过。

## 后续

仅继续 S03 的 workflow 阶段可见卡片；不得在同一 Session 执行 S04，不重启服务，不修改 `workflow-test`。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/271_PLAN_20260728_工作流诊断与飞书操作导航.md`、
`docs/273_HANDOVER_20260728_Feishu帮助分页S02交接.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S03：复用 workflow 文档的 `plan`、`slice`、`plan_progress` 与路径，在 PLAN 审批卡以及启动下一 Session 的 workflow 提示/卡片中显示所属 PLAN、当前或将执行的 Slice、文档状态和下一动作；缺失信息显示“未声明”，不得从正文猜测。覆盖 PLAN、HANDOVER 和终态文档显示；不改变审批、cursor、Session 或消息路由语义。对将修改的共享 symbol 先运行 GitNexus upstream impact。完成相关卡片测试、TypeScript、相关 ESLint、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建 S03 完成后仅允许执行 S04 的 HANDOVER；提交后停止，不执行 S04，不重启服务或修改 `workflow-test`。
<!-- WORKFLOW_PROMPT_END -->
