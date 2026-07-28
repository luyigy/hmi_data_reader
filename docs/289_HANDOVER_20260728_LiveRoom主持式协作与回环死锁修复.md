---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: live-room-moderated-collaboration
plan_progress: complete
---

# HANDOVER · Live Room 主持式协作与回环死锁修复

## 交付状态

- 修复提交：`0fc621475f97d2d4a1ebeabec2e136edb2ece855`
- 代码已提交到 `oss-prep`，尚未重启 `agent-platform-feishu.service`，线上运行实例仍是旧逻辑。
- 没有数据库 Schema、公共 API、外部集成配置或权限模型变化。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未提交。

## 事故现象与证据

2026-07-28 17:11–17:12 的一次 Live Room 协作中：

1. Codex 接到 Workflow PLAN 修订任务并输出 `$antigravity ...`。
2. Antigravity 正常完成审阅，再输出 `$codex ...` 把结果交回主持人。
3. 平台识别到了 `$codex`，但 Codex 没有再次开始执行。
4. 数据库中 Antigravity 的回复已经 `delivered`，回交 Codex 的 delivery 保持 `pending`；
   Antigravity Session 留在 `busy`，用户后续消息也只会继续排入 Codex 队列。

这次停止与 permission request、`waiting_for_input` 或 Codex app-server 退出无关。

## 根因

`processLiveRoomDelivery` 在一个 Agent 输出 `$member` 后，会同步等待被提及成员的下一次执行。
成员执行队列又要求同一成员的新任务等待旧任务完全结束，因此形成循环等待：

```text
Codex 原任务等待 Antigravity
  → Antigravity 等待回交给 Codex 的新任务
    → 新 Codex 任务等待 Codex 原任务释放队列
```

仅把嵌套调用改成异步虽然可以解除死锁，但仍会保留 Agent 自由互相点名、轮次失控和难以收敛的问题，
所以本次选择更明确的主持式协作语义。

## 最终行为决策

### 普通 Live Room 回复

- Agent 输出中的 `$member` 或 `@member` 只作为房间可见引用，不再自动调度下一位 Agent。
- 用户消息、`/ap chat --from-member --to-member` 和结构化 orchestrator 仍能显式调度一个成员。
- Agent 提示词不再教 Agent 使用 `$member` 自治接力；需要多人协作时使用 `/ap plan` 或 `/run`。

### `/ap plan`

- 保留既有顺序：主持人定义约束，其他成员按房间顺序各给一次建议，最后回到主持人定稿。
- 新增内部 `--revise=<PLAN path>` 模式，用于修订现有 PLAN；路径必须是仓库内合法三位编号 PLAN。
- 修订模式只允许主持人返回并提交指定 PLAN，返回其他路径时直接失败。

### Workflow PLAN 修订

- `PLAN_REVISE` 不再执行 `/ap new-session`，继续使用当前 TaskSession 和各成员 continuation。
- Workflow 将审批反馈交给主持式 PLAN 流程：主持人梳理约束，成员依次审阅，主持人综合意见后只修改原 PLAN。
- 修订完成后由现有 workflow validator 对新提交复验。

## 关键代码入口

- `src/lib/live-room-delivery.ts`
  - 删除 Agent 回复后的递归 mention 调度和失效的 `allowChainedMentions` 参数。
- `src/lib/live-room-protocol.ts`
  - 将 `$member` 自治接力说明改为主持式轮次说明。
- `src/lib/live-room-workflows.ts`
  - 解析、校验 `--revise`，复用既有 `/ap plan` 顺序阶段并限制提交路径。
- `src/lib/feishu-workflow.ts`
  - 识别 `PLAN_REVISE`，复用当前 Session 并转入主持式 PLAN 修订。

## 验证结果

以下检查已通过：

- `tests/live-room-workflows.test.ts`
- `tests/live-room-directed-protocol.test.ts`
- `tests/live-room-scheduling.test.ts`
- `tests/feishu-workflow-card.test.ts`
- `npm run test:live-room-queue`
- `npm run test:workflow-watcher`
- `npx tsc --noEmit`
- `npm run check:long-files`
- `git diff --check`
- GitNexus `detect_changes(scope: staged)`

`src/lib/live-room-delivery.ts` 从 1716 行降至 1680 行，没有增长历史超限文件。GitNexus 风险仍标为
`critical`，原因是共享投递入口同时服务网页 Live Room、飞书聊天和 Workflow；实际改动限定在取消递归
接力、复用现有主持流程，没有修改首轮投递、执行器、权限或消息持久化。

## 部署与真实验收

本会话遵守“不重启服务”边界，因此尚未执行真实飞书端到端验证。后续在用户明确批准重启后：

1. 重启 Agent Platform 飞书运行时，使 `0fc6214` 生效。
2. 检查旧房间遗留的 `pending` delivery 和 `busy` Session；不要直接删除数据库记录。
3. 必要时通过现有 `/ap stop --all`、`/ap new-session` 恢复旧房间，不手工伪造完成状态。
4. 在隔离测试房间验证普通 Agent `$member` 不再自动接力。
5. 发起一次 PLAN revision，确认 Session/Thread 保持不变，成员顺序回复，主持人最后只提交原 PLAN。
6. 验证普通用户定向消息、`/ap plan` 新建 PLAN 和 `/run feature|debug` 没有回归。

## 已知边界

- 已经运行中的旧 Node 进程不会热加载本提交，旧死锁队列不会因 Git 提交自行恢复。
- PLAN revision 的主持式阶段仍受 workflow completion timeout 和各 Harness 自身可用性约束；
  单个阶段失败会明确报告 `PLAN 未提交`，不会伪装成功。
- 本次没有实现通用的无限轮次讨论模式；需要多轮协商时由用户重新发起 `/ap plan`，避免自治循环。

## 建议下一会话任务

读取 `docs/289_HANDOVER_20260728_LiveRoom主持式协作与回环死锁修复.md` 和提交
`0fc621475f97d2d4a1ebeabec2e136edb2ece855`。先确认工作区和服务当前状态；只有得到用户明确批准后才重启
Agent Platform 飞书运行时。重启后不要直接修改或删除数据库记录，先使用现有状态命令检查旧房间的
pending delivery、busy Session 和进程队列，必要时通过 `/ap stop --all`、`/ap new-session` 恢复。
随后在隔离测试房间完成三组真实飞书 smoke：普通 Agent `$member` 仅展示且不自动接力；
PLAN_REVISE 复用原 Session/Thread，成员按顺序各回复一次并由主持人只提交原 PLAN；普通用户定向消息、
新建 `/ap plan` 和 `/run feature|debug` 无回归。准确记录实际命令、状态变化和结果；发现失败时保留证据，
不得手工伪造 workflow 状态。
