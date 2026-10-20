---
doc_type: REPORT
doc_status: verification_pending
---

# Ticket Agent A/B 部署与真实验收入口

用户授权直接部署测试后，主工作区已快进合入 A/B 至 `cca4049`。测试 Spec 单独提交 `ef6cb31`；不重写历史，不修改数据库 schema。

## 当前检查

- 协调器、任务卡片服务、网页服务已重启，均 active。网页 `/api/health` 返回 healthy。
- 在合入后的主工作区重新运行 `task-graph-skill-runtime`、`task-graph-runtime-pinning`、`task-graph-continuation-eligibility`，退出 0。[日志](../evidence/ticket-agent-autonomy/deploy/merged-smoke.log)。真实 poteto 包和项目适配还在两份专用测试仓内完成了严格 Bubblewrap 预检。
- 部署前后核对原有 30 个 execution 的状态、claim、TaskRun、commit、progress 及 node 状态，全部相同。[核对结果](../evidence/ticket-agent-autonomy/deploy/existing-ticket-check.json)。没有恢复现有业务 Ticket。
- 飞书消息服务承载本轮 Codex 进程，当前回复完成前不重启它。独立 cutover service 将等待本轮 TaskRun 和 LiveRoomDelivery 结束、没有其他活跃 TaskRun，再重启飞书服务。新 PID、启动标记、相关服务、HTTP 和数据库检查通过后才记 completed，并向当前 DM 通知。

最后一步的实时回执为 `output/reviews/ticket-autonomy-deploy-20261020/cutover.json`，对应后台单元 `agent-platform-ticket-autonomy-cutover-20261020.service`。本文件不把待执行切换写成已完成。

## 真实测试入口

依照 AGENTS.md，真实路线必须由用户在飞书确认卡批准，不能用直接部署授权伪造卡片回调。

- 群：工作流测试群。
- 父话题：验收专用 · Ticket Agent A/B · 20261020。
- 父任务：`acceptance-ticket-autonomy-20261020-cca4049`。
- 路线：`cmvgknqsv00017ozur253mlj0`，发出时 pending，尚未派发。
- 卡片：`om_x100b6240d2b6187cb0b8c10cdaac834`，已回读确认 chat/thread 对应专用话题。[收据](../evidence/ticket-agent-autonomy/deploy/proposal.json)。
- [测试 Spec](../specs/ticket-agent-autonomy-acceptance/spec.md)；[父 Issue](https://gitee.com/luyi1678/agent-platform-v2/issues/IKP79K)、[T01](https://gitee.com/luyi1678/agent-platform-v2/issues/IKP79L)、[T02](https://gitee.com/luyi1678/agent-platform-v2/issues/IKP79M)。

T01 用独立 label 仓验证同一 Agent 正常提问、补材料、实施和独立 Codex 验收。T02 用独立 consumer 仓验证只有验收通过才能放行后继。两个仓均位于 `/data1/code/ap-autonomy-acceptance-20261020/`，没有业务仓写入权限。

用户点击确认后，等 T01 询问材料，在 T01 话题回复“尺寸42，颜色蓝色”。可先问进度，再纠正材料。平台应将输入交给同一实施者，并保持原 Session、工作区及预算。确认卡只批准测试路线，不恢复生产 Ticket。

## 测试配置和剩余验收

仅为两个专用测试仓登记 poteto 固定技能包的精确只读目录，未更改已有项目条目。工作流测试群启用了平台现有话题隔离功能以创建测试话题；此前状态和配置备份保留在上述输出目录。没有新增权限例外或另开竞争飞书事件连接。

真实 Codex 的完整交互、检查、独立验收和后继放行仍待确认卡批准后运行。当前不声称该端到端验收已通过。
