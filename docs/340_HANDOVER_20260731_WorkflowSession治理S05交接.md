---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S05
plan_progress: in_progress
---

# HANDOVER · Workflow Session 治理 S05 交接

## 完成内容

- `runWorkflowInBoundLiveRoom` 不再为每个 executable workflow action 调用
  `new-session --all --blank`。连续工作单元复用当前 TaskSession，并把 dispatch 从 `prepared` 显式推进到
  `rotation_not_required`；既有 `session_reset` 状态仍可继续恢复，未改写历史 checkpoint。
- workflow 完成回执和状态投影改为“启动下一工作单元”，并明确 Session 是否换代由独立决策决定，不再把
  `next_slice` 等同于新 Session。
- 手工 `/ap new-session` 在停止旧运行前检查并展示：
  - running / queued TaskRun 或 Live Room delivery；
  - dirty workspace；
  - 当前 HEAD 中未完成的 PLAN；
  - 是否提供了当前 HEAD 已提交的 Handover。
- 风险确认卡仅允许原请求人操作，提供“生成并提交 Handover 后切换 / 直接切换 / 取消”。取消不停止运行、
  不清理 thread、不创建 TaskSession。
- “生成并提交 Handover”使用合同合格的独立 HANDOVER，只提交该新文件；原有 staged、unstaged 和
  untracked 改动保持原状。重复 rotation key 可从 commit trailer 找回同一 Handover。
- 确认后的换代沿用同一 rotation key，并从既有事实恢复：TaskSession metadata、Task Room reset marker、
  Live Room reset marker、member thread、bootstrap message 和 completion metadata。服务在任一步骤中断后，
  重试只补缺失副作用。
- `manual / semi_auto` 没有增加未经确认的自动换代；`auto` 仅保留既有 dispatch/event key 接入边界。
  本 Slice 未实现水位阈值、房间最大水位或自动 rotation。

## 修改文件

- `src/lib/feishu-workflow.ts`
- `src/lib/feishu-new-session.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/scheduled-jobs/workflow-status.ts`
- `prisma/schema.prisma`（仅补充已有 String 状态注释，无 schema 变化）
- `tests/workflow-dispatch-recovery.test.ts`
- `tests/new-session-rotation.test.ts`
- `tests/feishu-job-command.test.ts`
- `package.json`
- 本 HANDOVER

## 验证结果

- workflow dispatch recovery：连续两个 Slice 均记录 `rotation_not_required`，不重置 TaskSession；旧
  `session_reset`、Feishu 卡片、Room prompt 和 reply delivery checkpoint 恢复通过。
- new-session rotation：四类风险、三种按钮、非请求人拒绝、取消路径、生成并精确提交 Handover 通过；
  Session 创建、reset marker、Live Room marker、thread 清理、bootstrap、completion 六个故障点均证明只补
  剩余副作用。
- 工作区保护 fixture 同时保留用户 staged `README.md` 和 untracked `dirty.txt`。
- workflow watcher、自治模式、Feishu mode/access/permission/relay/job command 关联回归通过。
- `npx tsc --noEmit`、定向 ESLint、`npm run check:long-files`、`git diff --check` 通过。

## 数据、外部动作与边界

- 没有数据库字段、migration 或公共 API 变化；`WorkflowDispatch.state` 仍为现有 String 字段。
- 未部署、未重启服务、未发送真实飞书消息、未修改共享数据库。
- 未实现 S06 的 65% / 70% / 85% 阈值、provider freshness、房间最大水位或自动换代。
- 未开始 S07 Roadmap/Inbox，也未新增第二套 Session 状态机。
- 手工确认时按需扫描 HEAD 中已提交的 workflow 文档；只有实测仓库规模导致确认延迟时才需要索引投影。
- 保留且不提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、Inbox 和登录二维码等开工前文件。

## GitNexus 影响

- `handleNewSessionCommand`、`resolveHandoverPath`、`buildNewSessionPrompt` 为 CRITICAL，直接覆盖飞书命令和
  workflow 入口，并间接影响 Webhook/长连接；已用命令、卡片、workflow 和恢复测试覆盖。
- workflow 状态 `nextStepFor` 为 HIGH，影响 Web Dashboard、飞书 policy/dashboard 和 job 命令；本次只
  修改展示语义，并运行关联回归。
- `runWorkflowInBoundLiveRoom` 和卡片 callback 路由为 LOW；旧 checkpoint 保持兼容。

## 下一步

执行 PLAN 的 S06：只实现房间最大可信上下文水位和平台托管安全换代，不开始 S07 Roadmap/Inbox。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S06：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN 和
`docs/340_HANDOVER_20260731_WorkflowSession治理S05交接.md`，以及 S05 的 workflow dispatch、
TaskSession rotation checkpoint、Codex/Kimi provider context usage、Antigravity input token 遥测、
Live Room 在线成员与工作相关性实现。保护所有开工前用户改动，运行 `npm run check:long-files`。只实现
房间最大可信上下文水位与平台托管安全换代：Codex/Kimi 必须校验 freshness 和 Session 匹配；
Antigravity 使用最近一次 input tokens，未知模型按 1,048,576 分母并标注估算；实现可配置的 65% checkpoint
准备、70% rotation pending、85% 高优先级告警，unknown/过期/不匹配仅提示。rotation 必须复用当前
workflow event key，在 claim 前不得 stop/reset/start；按“提交真实成果与紧凑 Handover → claim →
停止旧 Session → 同工作目录以 Handover 启动 blank Session → bootstrap/binding 完成 → 恢复派发”的顺序
逐步可恢复。Antigravity 参与房间告警但不得对自身执行 `/ap new-session`；account quota 和消息/事件/
transcript 代理指标不得触发自动换代。不得开始 S07 Roadmap/Inbox 或新增第二套 Session 状态机。修改任一
function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成多 Agent 最大比例、
provider freshness/Session 匹配、Antigravity 1M fallback、阈值边界/配置覆盖、unknown 降级、Kimi
换代和每个 rotation checkpoint 崩溃恢复的聚焦测试，以及 TypeScript、定向 ESLint、
`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S06 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
