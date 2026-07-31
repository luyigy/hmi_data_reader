---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S04
plan_progress: in_progress
---

# HANDOVER · Workflow Handoff 审批 PLAN S04 交接

## 完成内容

- 普通 Handoff 根链在最后一位 Agent 不再继续 handoff 时，飞书回复卡显示“将本轮讨论生成审批 PLAN”
  按钮；普通聊天、directed visible 和仍有下一位成员的 handoff 不显示该入口，也不从自由文本猜意图。
- 点击后校验按钮所属房间仍与当前飞书会话绑定，只选择现有唯一 planner/主持 Agent。主持 Agent 读取当前
  根消息及所有携带同一 `handoffRootMessageId` 的回复，直接综合既有讨论，不重新发起成员讨论。
- 主持 Agent 只运行一次，生成一份新 PLAN，并必须写入
  `<!-- HANDOFF_PLAN_SOURCE: <rootMessageId> -->` 来源标记。系统只提交该 PLAN 文件，不夹带 Agent
  可能产生的其他工作区改动。
- PLAN 继续使用现有合同和审批链：Git 中的审批候选为 `ready + start_first_slice`，watcher hard gate
  通过后导入飞书文档并发送现有审批卡。批准前不会派发；修改、拒绝、批准以及首 Slice event key 都仍由
  原 workflow review/watcher 控制。
- 现有审批链没有单独的 `draft → ready` 转换。这里的“草案”是用户尚未批准的可执行候选语义；若写为
  `draft + none`，按当前合同只会 soft lint，不会发送审批卡。S04 没有为此新增第二套审批状态机。
- S03 自治模式继续决定批准后的行为：`manual` 保留 approved pending，等待用户执行
  `/ap job run workflow-watcher`；`semi_auto / auto` 使用同一 pending key 自动启动首 Slice。

## 幂等与恢复

- 复用现有 `WorkflowDispatch`，以 `sourceTaskId + live_room_handoff_plan +
  handoff-plan:<roomId>:<rootMessageId>` 建立唯一 claim；重复点击和重复 callback 只能有一个生成者。
- PLAN commit 带 `Handoff-Plan-Event` trailer。若服务在 commit 后、Room 回执或 checkpoint 更新前中断，
  下一次点击从 Git 找回同一 PLAN，不再运行主持 Agent。
- Room 回执以同一 event key 写入 metadata；checkpoint 丢失时优先复用已有回执。成功后
  `WorkflowDispatch.messageId` 指向该回执，后续点击直接展示同一 PLAN 路径。
- 进程在主持 Agent 尚未 commit 时中断，checkpoint 保持 `running`，重复点击只显示“正在生成”，不会
  并发创建第二份。失败会标记 `failed` 并给出可重试提示；重试提示主持 Agent 先按来源标记复用工作区中的
  同一草稿。
- 审批轮次和首次 Slice 幂等未复制到 S04 模块，仍由 watcher cursor 的 pending key、review attempt
  和既有 `WorkflowDispatch` 执行 checkpoint 保证。

## 修改文件

- `src/lib/live-room-handoff-plan.ts`
- `src/lib/feishu-live-room-relay.ts`
- `src/lib/feishu-long-connection.ts`
- `tests/live-room-handoff-plan.test.ts`
- `tests/feishu-live-room-relay.test.ts`
- `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md`
- 本 HANDOVER

## 验证结果

- Handoff PLAN fixture：通过；使用临时真实 Git 仓库、真实 commit、fake runner/Room/DB，证明根链只选择
  当前 transcript，同一事件只运行一次主持 Agent、只提交一份 PLAN，并覆盖 commit 后 checkpoint 丢失
  的恢复。
- Feishu Live Room relay 测试：通过；末条 handoff 回复显示显式按钮，既有卡片和文本 fallback 无回归。
- Live Room workflow 与 Feishu `/ap plan` 测试：通过。
- Live Room handoff 测试：通过。
- `npm run test:workflow-watcher`：通过；覆盖现有审批修改、拒绝、批准、pending key 和首 Slice 派发。
  测试中的 non-fast-forward fatal 是预期 append-only guard 场景。
- `npm run test:workflow-autonomy`：通过；覆盖 manual、semi_auto、auto 的批准后推进矩阵。
- `npx tsc --noEmit`：通过。
- S04 修改文件定向 ESLint：通过。
- `npm run check:long-files`：通过；`feishu-long-connection.ts` 为 998 行，未跨越 1000 行阻断阈值。
- `git diff --check`：通过。

## 未执行与上线边界

- 未部署数据库 migration、未修改共享数据库、未重启服务，也未发送真实飞书卡片。S04 没有新增 migration；
  S03 的 `20260731113000_add_workflow_autonomy` 仍需用户授权后才能部署。
- 未做真实 Feishu 点击到文档导入的 E2E；本 Slice 使用 fake 外部边界和现有 watcher/审批回归证明组合
  行为，真实验收留在 S08 或用户授权的部署测试。
- 未修改现有 `/ap plan`、workflow watcher/review、公共 API、Live Room handoff claim、Session
  rotation、上下文水位或 Roadmap/Inbox。
- 保留且未提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、Inbox 和登录二维码等开工前文件。

## GitNexus 影响

- `runLiveRoomPlan` upstream impact 为 CRITICAL，涉及 Live Room API、飞书命令、workflow revision 等
  6 条流程；`handleFeishuPlanCommand` 为 HIGH。S04 因此没有修改这两个符号，而是新增独立的单主持
  handoff promotion 薄模块。
- `buildAssistantRelayCard` 与长连接 `buildCardActionHandler` 均为 LOW。前者只在带根 handoff 且没有
  下一跳时增加按钮，后者只增加一条 callback 路由。
- GitNexus 索引已增量刷新到 S03 HEAD。最终 staged `detect_changes` 为 medium：识别 5 个代码/测试
  文件、35 个符号和 1 条 Feishu relay 流程；新增 promotion 模块已进入索引。相对 `master` 的 compare
  因当前分支 251 个历史文件、1836 个符号和 248 条流程仍为 critical，不代表 S04 单独扩散。

## 下一步

执行 PLAN 的 S05，只解耦 workflow 动作推进与 Session 换代，并完成手工 new-session 安全确认；不得
开始 S06 水位策略或 S07 Roadmap/Inbox。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S05：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/338_HANDOVER_20260731_WorkflowHandoff审批PLAN_S04交接.md`，以及现有 workflow dispatch、
`runWorkflowInBoundLiveRoom`、TaskSession、`/ap new-session`、Handover、安全工作区检查和 S03 自治模式
实现。保护所有开工前用户改动，运行 `npm run check:long-files`。只解耦“推进 workflow 动作”和“blank
Session 换代”：水位安全时连续 Slice 复用原 Session；需要换代时保留现有 event key 与可恢复 checkpoint，
未换代明确记录 `rotation_not_required`。为手工 `/ap new-session` 增加 running/queued、dirty
workspace、未完成 PLAN 和缺少 Handover 的确认卡，支持“生成并提交 Handover 后切换 / 直接切换 /
取消”。manual/semi_auto 的自动建议必须等待用户确认，auto 只保留接入点，不得提前实现 S06 阈值和自动
换代。不得开始 S06 房间最大水位、S07 Roadmap/Inbox 或新增第二套 Session 状态机。修改任一
function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成连续 Slice 复用、
确认卡四类风险和取消路径、每个 reset/rotation checkpoint 崩溃恢复的聚焦测试，以及 TypeScript、定向
ESLint、`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S05 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
