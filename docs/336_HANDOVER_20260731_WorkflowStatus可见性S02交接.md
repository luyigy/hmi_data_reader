---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · Workflow Status 可见性 S02 交接

## 完成内容

- 新增统一、只读的 `WorkflowStatus` 投影。事实来自项目配置、Git ref/HEAD、watcher cursor、
  `ScheduledJobState/Run`、`WorkflowDispatch`、Feishu room binding 与 `TaskSession`，没有新增数据库表、
  migration、状态机、事件总线或通知框架。
- 新增 `/ap workflow status`；原 `/ap job status workflow-watcher` 与 Workflow Dashboard 复用同一投影。
  飞书输出现在同时展示项目/ref/HEAD、PLAN/Slice/动作、审批、Session、Validator 分类、最近成功/错误、
  重试或隔离状态和唯一下一步。
- 新增 Web `/workflow` 页面及侧栏入口，展示与飞书相同的核心字段、完成回执和唯一下一步。
- Validator 状态明确区分 `valid`、`document_invalid`、`runtime_unavailable` 和未知状态。文档失败继续展示
  原始错误、重试或隔离证据；运行故障不会伪装成文档错误。
- watcher 对已提交 HANDOVER 使用既有幂等发送键主动发送完成回执。回执区分 Slice 完成并推进、
  interrupt PLAN 返回父 PLAN、PLAN 完成待验收，包含真实文档 commit、HANDOVER 中记录的实际验证、
  HANDOVER/验收入口和自动推进状态；重复 watcher 不会重复刷屏。
- 完成回执的 run summary 新增真实文档 `commit`，只读状态页可在重启后从既有
  `ScheduledJobRun.summary` 恢复展示。

## 验证结果

- `npm run test:workflow-watcher`：通过，覆盖完成回执、终态停止和 watcher 幂等；测试中的
  non-fast-forward fatal 输出是预期的 append-only guard 场景。
- Feishu job command 聚焦测试：通过，覆盖 `/ap workflow status` 解析、共享状态字段、Dashboard、
  验证结果提取和完成回执语义。
- `npm run test:scheduled-jobs`：通过。
- `npx tsc --noEmit`：通过。
- S02 修改文件定向 ESLint：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- `git diff --check`：通过。
- GitNexus `detect_changes --scope compare --base-ref master`：已运行；因 `oss-prep` 相对 `master` 的
  244 个历史变更文件返回 CRITICAL。为隔离本 Slice 又运行 staged 检查，S02 为 HIGH、9 个代码文件、
  25 个已索引符号、7 条预期 Workflow/Feishu 流程；未发现跨到认证、数据库写入或其他业务流程。
- 使用当前数据库与 Git ref 只读加载 `agent-platform-v2` 状态成功；投影能同时显示 watcher 停用状态、
  已保存的 `document_invalid` 证据和唯一恢复动作。

## 行为变化与边界

- 新增页面：`/workflow`；新增飞书只读命令：`/ap workflow status`。现有 policy、job 控制命令、审批、
  Session 派发和 cursor 写入行为不变。
- 未修改 Prisma schema、API、数据库数据、权限策略、自治模式或 Session rotation。
- 未启动 S03，未重启服务，未发送真实飞书消息，也未执行浏览器端到端验收。
- GitNexus 开工前 upstream impact：`handleScheduledJobCommand` 与 `handleFeishuCommand` 为 HIGH，原因是
  位于公共飞书消息入口；实际未修改 `handleFeishuCommand`，`handleScheduledJobCommand` 仅让两个只读
  状态入口消费共享投影，并由聚焦测试覆盖。`workflowWatcherHandler`、Dashboard card、Sidebar 与
  workflow policy handler 为 LOW。
- 保留并未提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、Inbox、登录二维码等开工前无关文件。

## 下一步

执行 PLAN 的 S03，只实现独立的 `workflowAutonomy = manual | semi_auto | auto` 合同、最小持久化与控制面；
不得把它混入 Live Room mode，不得提前开始 Handoff 提升、Session rotation 或 Roadmap 自动领取。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S03：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/336_HANDOVER_20260731_WorkflowStatus可见性S02交接.md`，以及现有项目配置、ScheduledJobState、
WorkflowStatus、Feishu 管理权限和 Workflow Dashboard 实现。保护所有开工前用户改动，运行
`npm run check:long-files`。只实现独立的 `workflowAutonomy = manual | semi_auto | auto` 合同、最小
持久化和查询/切换控制面，并把模式接入既有 S02 只读状态投影；不得修改 Live Room `mode`，不得开始
S04 的 Handoff 提升、S05 的 Session rotation 或 S07 的 Roadmap/Inbox 自动领取，不得新增通用工作流
引擎。项目配置是唯一默认值，切换必须复用现有项目/Feishu 管理权限，带预期 Git HEAD，并对重复命令和
重复卡片回调保持幂等；降级到 manual 后停止未开始的自动动作，但不破坏正在收口的原子工作单元。修改
任一 function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成三种模式推进
矩阵、权限、未绑定项目、过期/重复操作和降级行为的聚焦测试，以及 TypeScript、定向 ESLint、
`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S03 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
