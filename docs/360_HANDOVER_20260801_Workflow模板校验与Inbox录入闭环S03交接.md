---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md
slice: S03
plan_progress: in_progress
---

# HANDOVER · Workflow 模板、校验修复与 Inbox 录入闭环 S03

## 完成内容

- 新增 `/ap workflow validation show|set|template|repair`，文本命令、命令中心与 Workflow Dashboard 复用同一入口。
- `show` 从目标 ref 读取合同，并对 watcher 记录的最后失败文档重放现有 Validator，展示模式、hard gate、六项策略、
  error/warning 数量、稳定错误代码和唯一下一步；`template` 只返回对应诊断已有的最小模板片段。
- `set balanced|strict --head=<HEAD>` 复用管理员/项目审批人权限与 40 位 HEAD 乐观锁；只允许当前检出的 branch、
  clean 且无冲突的唯一 consumer 仓库，模式只写目标仓库合同并产生一个追加提交。重复请求或模式未变化不重复提交。
- `repair --head=<HEAD>` 以 `path + blob` 生成持久化 Workflow dispatch event key；复用现有房间投递与 completion gate，
  优先续接已有 Session，无可续接 Session 时才创建一次受控修复，同一 blob 不重复派单。
- 删除与 `352_PLAN` 语义重复且无引用的 `353_PLAN`；保留 `352_PLAN` 与本交接作为唯一继续入口。

## 验证

- `tests/workflow-validation-control.test.ts`：strict 结构化诊断、最小模板、balanced 追加提交、同模式幂等、过期 HEAD、
  dirty worktree、多 consumer、权限与 repair key。
- `tests/feishu-job-command.test.ts`：命令解析与 Dashboard validation 动作。
- `tests/feishu-help-command.test.ts`：命令中心只读 validation 动作。
- `npm run test:workflow-autonomy`
- `npm run test:workflow-validator`
- `npm run test:workflow-watcher`
- `npm run test:workflow-completion-gate`
- `npm run test:scheduled-jobs`
- `npx tsc --noEmit --pretty false`
- 定向 ESLint、`npm run check:long-files`、`git diff --check`

未执行真实 Feishu 消息、真实目标仓库模式切换、服务重启或数据库写入。重复派单与服务重启后的幂等性复用数据库中
已有的 `WorkflowDispatch(projectId, jobId, eventKey)` 唯一约束和既有 watcher/dispatch 回归，不新增 repair queue。

## 工作区边界

开工前已有的 `AGENTS.md`、`CLAUDE.md`、Workflow 计划清单/UI/status 改动保持未提交；本 Slice 只提交 validation
控制面、聚焦测试、重复 PLAN 删除和本 HANDOVER。计划选择下拉框仍按用户要求留到 S03 完成后再讨论，不在本 Slice
实现。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md` 的 S04：先读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml`、`docs/360_HANDOVER_20260801_Workflow模板校验与Inbox录入闭环S03交接.md`
与本 PLAN。保护所有开工前用户改动，只完成 S04：复用现有 Feishu 命令、项目绑定、管理员/审批人权限、40 位 HEAD
乐观锁和 Inbox 提案链，实现 `/ap inbox add <标题> [--body=<说明>] --head=<HEAD>`；只创建并提交 draft ISSUE，
不自动实施、不领取 ISSUE、不生成或批准 PLAN；完成 349 的拆分引用收口和端到端验证。修改任一 function/class/method
前运行 GitNexus upstream impact，完成权限、输入边界、过期 HEAD、dirty/conflict、重复消息和自治模式回归，运行
TypeScript、定向 ESLint、长文件检查、diff check 和 GitNexus detect_changes 后精确提交，并创建
`plan_progress: complete`、`next_action: await_acceptance` 的 S04 HANDOVER；提交后停止。当前 Slice：S04。
<!-- WORKFLOW_PROMPT_END -->
