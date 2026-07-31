---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S07
plan_progress: in_progress
---

# HANDOVER · Workflow Roadmap/Inbox S07 交接

## 完成内容

- `manual` 和 `semi_auto` 在 phase PLAN 完成后继续停在既有终态通知；只有 `auto` 可进入
  Roadmap/Inbox 提议接入点。`semi_auto` 仍只推进已批准 PLAN 内的 `next_slice`，不会回父 PLAN。
- `auto` 完成 interrupt PLAN 后继续复用既有、经 validator 校验的 `resume_parent` 路径；缺失或失效的
  父 PLAN、父 Slice、`return_to` 和 Prompt 引用仍由现有 validator fail closed。
- `auto` 完成 phase PLAN 后优先读取该 PLAN 关联的 Git Roadmap 未完成 checklist；未关联 Roadmap 时读取
  当前 branch space 下已提交的 `inbox/*.md`，忽略 README 和工作区未提交文件。
- 候选按 Git 中的稳定顺序选择；内容哈希同时绑定来源路径和候选条目。已有 PLAN 包含相同
  `WORKFLOW_INBOX_ITEM` 标记时视为已认领，不会重复创建。
- 新 PLAN 记录候选来源、候选条目、预期 HEAD、唯一 event key 和单一 S01，使用合同规定的
  `ready / start_first_slice / phase` frontmatter，并由 watcher 下一轮复用现有 PLAN 审批卡。审批前不启动。
- 提议前和提交前均核对监控分支 HEAD；非 branch ref、working tree 不在监控分支、HEAD 变化均停止。
  同一仓库/ref/branch space 在项目配置中存在零个或多个 workflow consumer 时明确 fail closed。
- 第一版没有增加 claim/lease、通用队列、新审批状态或第二套 workflow/Session 状态机。

## 修改文件

- `src/lib/scheduled-jobs/workflow-roadmap-inbox.ts`
- `src/lib/scheduled-jobs/workflow-watcher.ts`
- `tests/workflow-roadmap-inbox.test.ts`
- `package.json`
- 本 HANDOVER

## 验证结果

- 新聚焦测试覆盖无 Roadmap、README-only 空 Inbox、Inbox 候选、Roadmap 未完成条目、已认领条目、
  重复 watcher、审批卡接入、服务重启可恢复标记、旧 HEAD、consumer 冲突、manual/semi_auto/auto
  phase 终态边界，以及 semi_auto/auto 的 interrupt `resume_parent` 边界。
- 新生成 PLAN 已通过真实 workflow contract validator。
- `npm run test:workflow-roadmap-inbox`、`npm run test:workflow-autonomy`、
  `npm run test:workflow-watcher`、`npm run test:workflow-validator` 和 `npx tsc --noEmit` 通过。
- 定向 ESLint、`npm run check:long-files`、`git diff --check` 和 GitNexus 变更核验通过。

## 数据、外部动作与边界

- 没有数据库字段、migration、公共 HTTP API 或项目配置 schema 变化。
- 未部署、未重启服务、未发送真实飞书消息、未访问共享数据库；集成测试使用临时 Git 仓库和 fake sender。
- 提议创建 PLAN 会在目标监控分支追加一个精确提交；所有候选选择和去重只消费目标 Git HEAD。
- 未开始 S08 故障注入、真实 Feishu 验收或渐进上线。
- 保留且不提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、现有 `docs/inbox/` 和登录二维码等开工前文件。

## GitNexus 影响

- `workflowWatcherHandler` upstream impact 为 LOW：2 个直接依赖、0 条已索引执行流程；变更只在 phase PLAN
  完成后的 terminal gate 接入 Git 提议。
- `detect_changes(scope=compare, base_ref=master)` 报告分支累计 `critical`：260 个文件、1846 个符号、
  248 条受影响流程；这是 `oss-prep` 相对 `master` 的历史差异。
- staged 隔离核验为 4 个已索引文件、4 个符号、2 条受影响流程，风险 `medium`，只落在 watcher terminal
  gate 和本次新增的 Git 提议边界。

## 下一步

执行 PLAN 的 S08：完成故障注入、真实 Feishu 验收与渐进上线，并在终态 HANDOVER 后停止。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S08：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN 和
`docs/342_HANDOVER_20260731_WorkflowRoadmapInboxS07交接.md`，以及 S03–S07 的自治模式、审批、
workflow dispatch、Session rotation checkpoint、房间水位和 Roadmap/Inbox 实现。保护所有开工前用户改动，
运行 `npm run check:long-files`。只完成 S08 故障注入、真实 Feishu 验收与渐进上线：使用隔离数据库、
fake sender 和可控进程故障覆盖 PLAN 所列每个 rotation、delivery、cursor、审批卡、重复回调、服务重启和
Git HEAD 变化注入点，证明只补剩余步骤且不重复外部副作用；无法证明时进入 blocked 并通知。按
shadow/read-only、manual、semi_auto、单项目 auto 的顺序验收，保留一键降级 manual。不得扩大真实写入范围，
不得跳过审批，不得新增第二套 workflow、审批或 Session 状态机。任何真实 Feishu、共享数据库、部署、重启或
项目模式切换必须先取得用户明确批准；未获批准时完成可离线验证部分并准确记录阻塞。修改任一
function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成 PLAN 要求的聚焦/回归测试、
真实 Feishu E2E（若获批准）、TypeScript、定向 ESLint、`npm run check:long-files`、`git diff --check` 和
GitNexus staged/compare 变更核验后精确提交，并创建 `plan_progress: complete`、
`next_action: await_acceptance` 的 S08 终态 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
