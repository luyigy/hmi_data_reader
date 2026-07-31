---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S08
plan_progress: in_progress
---

# HANDOVER · Workflow 故障注入 S08 外部验收阻塞交接

## 已完成的离线验收

- 使用临时 Git 仓库、fake sender、内存态 Prisma stub 和可控异常复验 S03–S07 的既有状态机，没有新增
  故障框架或第二套 checkpoint。
- 新增 `HANDOVER commit 后、rotation claim 前` 断点：相同 rotation key 能从 Git commit trailer 找回
  同一 Handover，重试不产生第二个提交。
- 新增 `stop 已生效、新 TaskSession 创建前` 断点：重试读取已停止的运行/投递事实，只创建缺失的
  TaskSession，不再次产生停止副作用。
- 既有测试继续覆盖：
  - `rotation_pending` 落库后才进入 stop/reset/start；
  - TaskSession 创建后、Task Room marker、Live Room marker、thread cleanup、bootstrap 和 completion
    任一步骤崩溃后只补缺失副作用；
  - 新 Session 完成后、`rotation_completed` 落库前重试复用 event-keyed rotation；
  - workflow execution card 发送结果未知时进入 blocked，不盲目重发；
  - PLAN 审批卡 cursor 保存失败时复用相同 attempt 和 idempotency key，保存后不重复发卡；
  - 重复审批回调、重复 Handoff 提升、服务重入、重复 watcher 和重复 Roadmap/Inbox 提议保持幂等；
  - watcher cursor 未保存时复用同一 workflow event key，`reply_queued` 后不重复派发；
  - Git HEAD 变化、审批 HEAD 过期和 append-only 历史改写均 fail closed。
- fake 边界下的 manual、semi_auto、auto 推进矩阵、Handoff PLAN、审批修改/拒绝/批准、Session 水位换代、
  Roadmap/Inbox 和降级 manual 能力均通过现有聚焦测试。

## 本次修改

- `tests/new-session-rotation.test.ts`
- 本 HANDOVER

生产代码、数据库 schema、migration、公共 API 和项目配置均未修改。

## 当前阻塞

PLAN S08 明确要求真实 Feishu E2E 和按 `shadow/read-only → manual → semi_auto → 单项目 auto` 的渐进上线，
同时明确这些外部动作必须单独取得用户授权。本轮用户只要求“继续”，没有授权以下任何真实副作用：

- 连接或修改共享 PostgreSQL、部署 S03 migration；
- 部署代码或重启真实服务；
- 向真实飞书会话发送文档、审批卡、命令或回执；
- 修改真实项目的 workflow autonomy；
- 选择具体试点项目、chat、ref 和观察窗口。

因此本轮没有访问共享数据库、没有部署或重启、没有发送真实飞书消息、没有切换任何项目模式。S08 不能
标记 `plan_progress: complete`，也不能创建 `await_acceptance` 终态 Handover。

## 恢复条件

用户需明确给出：

1. 试点 `project id / job id / Git ref / Feishu chat`；
2. 是否授权执行 S03 migration、部署和服务重启；
3. 是否授权发送真实 Handoff/审批/new-session 测试消息并操作测试卡；
4. 是否授权按顺序切换 `manual → semi_auto → auto → manual`；
5. 每阶段观察时长和可接受的测试消息范围。

获授权后先重新核对目标 HEAD、共享 migration 状态、项目配置、服务状态和一键降级路径，再逐级执行。任一
阶段失败立即降级 manual，记录外部 message/session/event key，不继续下一阶段。

## 验证结果

- `npm run test:new-session-rotation`：通过，包含本次两个新增断点。
- workflow dispatch、watcher、自治模式、Roadmap/Inbox、validator、completion gate、Git history guard、
  workflow review concurrency、Handoff PLAN、Feishu relay/plan/job fake 回归：通过。
- TypeScript、定向 ESLint、long-file guard 和 diff check：通过。
- GitNexus upstream impact：修改的测试 `main` 为 LOW，1 个直接文件入口、0 条执行流程、0 个生产模块。
- `detect_changes(scope=compare, base_ref=master)` 为分支累计 `critical`：260 个文件、1925 个符号、248 条
  流程；staged 隔离为 `low`：1 个测试文件、1 个符号、0 条执行流程。

## 下一步

取得上述真实外部验收授权后恢复 S08；未获授权时保持 blocked，不重复执行离线测试或猜测试点目标。

## 非自动化恢复提示

以下内容仅供获得用户明确授权后手工启动下一 Session；blocked HANDOVER 不包含 workflow Prompt 标记。

恢复 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S08：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN 和
`docs/343_HANDOVER_20260731_Workflow故障注入S08外部验收阻塞交接.md`。保护所有开工前用户改动，先确认
用户是否已明确授权具体试点 project/job/ref/chat、共享 migration、部署/重启、真实飞书测试消息和
`manual → semi_auto → auto → manual` 模式切换；任一项未授权时不得执行并继续保持 blocked。获得授权后
重新核对目标 HEAD、migration、项目配置、服务状态和一键降级路径，按 shadow/read-only、manual、
semi_auto、单项目 auto 顺序完成真实 Feishu E2E，每阶段记录 message/session/event key、恢复结果和观察
结论，失败立即降级 manual。不得跳过审批，不得扩大试点范围，不得新增第二套 workflow、审批或 Session
状态机。修改任一 function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成真实
Feishu E2E、TypeScript、相关 ESLint、聚焦/回归测试、`npm run check:long-files`、`git diff --check` 和
GitNexus staged/compare 核验后精确提交，并创建 `plan_progress: complete`、
`next_action: await_acceptance` 的 S08 终态 HANDOVER；提交后立即停止。
