---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S06
plan_progress: in_progress
---

# HANDOVER · Workflow 房间水位与安全换代 S06 交接

## 完成内容

- workflow 在派发新工作单元前只采集已加入、可回复且 `online / busy` 的当前任务成员水位；provider telemetry
  仍由当前 task、participant continuation key 和 reset 边界约束，房间决策取可信百分比最大值。
- Codex telemetry 现在同时要求 15 分钟 freshness 与当前 `codexThreadId` 完全匹配；Kimi 保留既有
  freshness、`kimi_session` 类型和 Session ID 严格匹配。
- Antigravity 使用最近一次运行的 `input_tokens`。已知模型优先使用模型映射；未知模型使用
  `1,048,576` 分母并展示 `1M assumed`。缺少时间、过期或未来时间 telemetry 降级为 unknown。
- 新增可配置阈值 `session_rotation.checkpoint_preparation_percentage`、
  `rotation_pending_percentage`、`high_priority_percentage`，默认分别为 65、70、85，并校验严格递增。
- 低于 65% 记录 `rotation_not_required`；65–69% 记录 `rotation_checkpoint_prepared`、提示收束原子步骤
  与准备精简 Handover，但继续复用原 Session；70% 起进入换代流程；85% 起显示高优先级告警。
- unknown、过期、Session 不匹配以及消息数、事件数、transcript 等代理指标不会触发自动换代；存在部分
  unknown 样本时会在可信决策旁单独提示。
- `manual / semi_auto` 在 70% 水位只发送确认卡并等待用户操作。确认回调使用同一 workflow event key
  从 `rotation_confirmation_required` 原子 claim 到 `rotation_pending`；取消回到
  `rotation_not_required`，不停止旧运行。
- `auto` 先复用当前事件引用的已提交 Handover；缺失时生成并精确提交 event-keyed 紧凑 Handover。随后
  原子 claim `rotation_pending`，再沿用 S05 checkpoint 停止旧运行、创建同 working directory 的 blank
  TaskSession、清理旧 thread、写 reset/bootstrap，完成后记录 `rotation_completed` 并恢复 workflow
  dispatch。
- Antigravity 参与房间最大水位和告警，但 `rotatable-only` 会把它排除在 `/ap new-session --all` 目标外。
  Codex/Kimi 等持久 Session 才会换代；Kimi 的旧 thread 被清除，新 Session 只接收 blank +
  Handover bootstrap。

## 修改文件

- `src/lib/workflow-session-rotation.ts`
- `src/lib/feishu-workflow.ts`
- `src/lib/feishu-new-session.ts`
- `src/lib/live-room-members.ts`
- `src/lib/codex-telemetry.ts`
- `src/lib/real-agents/antigravity-context.ts`
- `prisma/schema.prisma`（仅扩充既有 String 状态注释，无 schema 变化）
- `tests/workflow-session-rotation.test.ts`
- `tests/workflow-dispatch-recovery.test.ts`
- `tests/new-session-rotation.test.ts`
- `tests/codex-telemetry.test.ts`
- `tests/antigravity-context.test.ts`
- `package.json`
- 本 HANDOVER

## 验证结果

- 多 Agent 最大比例、65/70/85 边界、项目配置覆盖、unknown 降级和高优先级提示通过。
- Codex freshness / 当前 thread 匹配、Kimi freshness / Session 类型与 ID 匹配通过。
- Antigravity 已知模型映射、未知模型 1M fallback、显式 assumed 标签、缺失/过期时间降级通过。
- new-session 的 Session 创建、Task Room reset marker、Live Room marker、thread 清理、bootstrap 和
  completion checkpoint 恢复通过；`rotatable-only` 证明 Kimi 获得新 blank bootstrap、Antigravity
  不进入换代目标。
- workflow dispatch 的 Handover-before-claim、`rotation_pending` 重试、`rotation_completed` 响应丢失、
  manual 确认卡外部结果未知等恢复路径通过。
- `npx tsc --noEmit`、定向 ESLint、workflow autonomy / watcher 回归、`npm run check:long-files` 和
  `git diff --check` 通过。

## 数据、外部动作与边界

- 没有数据库字段、migration 或公共 HTTP API 变化；`WorkflowDispatch.state` 继续使用已有 String 字段。
- 未部署、未重启服务、未发送真实飞书消息、未修改共享数据库。
- account quota 未接入水位判断；普通 Room payload、消息/事件/transcript 指标未成为 rotation trigger。
- 未开始 S07 Roadmap/Inbox，也未新增第二套 Session 状态机。
- 保留且不提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、Inbox 和登录二维码等开工前文件。

## GitNexus 影响

- `handleNewSessionCommand` 为 CRITICAL，覆盖 Feishu webhook、长连接命令、scheduled workflow 与 workflow
  runner；新增选项默认关闭，并以命令、Kimi/Antigravity 目标过滤和全部 S05 checkpoint 测试覆盖。
- `getAntigravityProviderContextUsage` 为 HIGH，影响水位检查、participant 执行与 Live Room 消息 API；
  保持原字段兼容，只新增可信百分比与 assumed 元数据，并运行遥测和相关 workflow 回归。
- Codex telemetry、Live Room 水位、workflow runner 和执行卡为 LOW。
- 合同要求的 `detect_changes(scope=compare, base_ref=master)` 如实报告分支累计 `critical`：`oss-prep`
  相对 `master` 已有 258 个文件、1846 个符号的历史差异；补充的 staged 隔离检查为 13 个文件、20 个符号、
  4 条受影响流程，风险 `medium`，均落在本 S06 的 workflow dispatch、context watermark、telemetry 与测试
  边界。

## 下一步

执行 PLAN 的 S07：实现 Semi-auto / Auto 推进与 Roadmap/Inbox，所有新 PLAN 仍必须等待用户审批。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S07：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN 和
`docs/341_HANDOVER_20260731_Workflow房间水位与安全换代S06交接.md`，以及 S03 自治模式、S04 Handoff
审批 PLAN、S06 workflow dispatch/event-key rotation checkpoint、父 PLAN/interrupt 引用和现有
Roadmap/Inbox 相关实现。保护所有开工前用户改动，运行 `npm run check:long-files`。只实现
Semi-auto / Auto 推进与第一版 Git Roadmap/Inbox：manual 不自动推进；semi_auto 只推进当前已批准 PLAN
内的下一 Slice，PLAN 完成后停止并提示；auto 在 interrupt PLAN 完成后按 `resume_parent` 返回有效父 PLAN，
phase PLAN 完成后才可从关联 Roadmap/Inbox 选择未完成且未被现有 PLAN 认领的一项，记录候选条目、预期
HEAD 和唯一 event key，生成新 PLAN 并发送既有审批卡，审批前必须停止。用户拒绝、切回 manual、HEAD
改变、父引用失效或多房间并发安全未证明时 fail closed 并明确通知；只有出现真实并发需求才增加最小
claim/lease，不预建通用队列。不得绕过 PLAN 审批，不得开始 S08 故障注入/真实上线，不得新增第二套
workflow、审批或 Session 状态机。修改任一 function/class/method 前运行 GitNexus upstream impact，
HIGH/CRITICAL 先报告。完成 manual/semi_auto/auto 边界、父 PLAN resume、无 Roadmap、空 Inbox、条目已认领、
重复 watcher/卡片、服务重启、HEAD 变化和并发 fail-closed 的聚焦测试，以及 TypeScript、定向 ESLint、
`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S07 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
