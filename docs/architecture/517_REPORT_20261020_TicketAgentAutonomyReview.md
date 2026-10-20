---
doc_type: REPORT
doc_status: completed
---

# Ticket Agent A/B 审查交接

## 当前结果

A/B 已部署。用户确认的专用飞书测试路线已完成，T01、T02 均 passed，执行记录均 integrated。T01 收到补充材料后沿用原 Codex Session 实施，验收通过后自动放行 T02。本轮整理交接与证据，没有恢复现有业务 Ticket。

本文件按用户要求供其他 Agent 审查，不启动任务或下一阶段。它更新 [515 实施报告](515_REPORT_20261020_TicketAgentAutonomyABImplementation.md) 和 [516 部署记录](516_REPORT_20261020_TicketAgentAutonomyDeployment.md) 当时尚待完成的验收状态。历史文档保留原样。

## 审查代码范围

分支 `oss-prep`，推送目标 `gitee/oss-prep`。本次代码审查使用：

```bash
git diff bbc574d..772ae88 -- src tests scripts
```

- `0b316f2` 实现 A，Runtime Capability Preflight。
- `c1e1d9d` 实现 B，Normal Ticket Continuation。
- `cca4049` 规范验证日志空白。
- `ef6cb31` 提交专用测试 Spec。
- `772ae88` 记录部署与真实验收入口。
- 本交接提交只增加文档和验收证据。

远端此前落后本地 38 个提交，推送会同时包含那些已存在的提交。它们不全部属于 A/B；请用上述固定范围审查，勿按整个推送范围判断本次改动。

## 改了什么

### A：技能在真正的沙箱里可用

原来能发现 SKILL.md，不代表其脚本、映射、playbook 在 Bubblewrap 中也能访问。现在项目声明必需技能包，宿主先授权精确目录，再只读挂载完整包。预检在实际沙箱中读取依赖并运行包检查器。执行与续接前复核资源身份，缺项时不会先调用模型。

主要文件为 `runtime-contract.ts`、`runtime-preflight.ts`、新增的 `skill-resource-preflight.ts`、`runtime-continuity.ts` 和 `acpx/runner-harness.ts`。前四个文件位于 `src/lib/task-graph/`。

发现资源、授权资源、挂载资源、验证资源仍分开。发现 symlink 不等于授权其目标，不能递归放行任意目标，也没有挂载整个 HOME。

### B：正常交互回到原实施者

新产生的普通等待和补材料使用已有 `waiting_for_user`，消息经现有 inbox 回到原实施入口。平台在旧 writer 退出、输入来源合法、阶段及范围允许、claim/revision 等快照仍匹配时安排下一轮。慢速观察放在事务外，事务内再次核对精确快照。

主要文件为 `conversation-inbox.ts`、`implementation-result.ts`、`coordinator.ts`、`conversation-followup.ts`、`restart-recovery.ts` 和 `prompts.ts`，均位于 `src/lib/task-graph/`。Prompt 删除了两段内部接力说明，没有增加体验补丁规则。

未交付本身不授予写入资格。环境缺失、上游绑定缺失、范围变化、权限不足、预算耗尽、活跃或未知 writer、验收中和已交付成果仍有各自边界。历史 Followup、旧恢复记录与只读验收会话继续兼容。没有新增状态枚举、恢复预算或数据库 schema。

## 验证证据

合同见 [514](514_ARCH_20261020_TicketAgentAutonomyABContract.md)。完整红绿回归与覆盖边界见 [515](515_REPORT_20261020_TicketAgentAutonomyABImplementation.md)，原日志保留在 [ab 目录](../evidence/ticket-agent-autonomy/ab/)。包括实际 Bubblewrap、完整 poteto 包、资源固定、27 个 continuation eligibility 场景、输入来源、并发边界、旧协议和重启回归。

两处旧重启夹具原先用伪造的已退出 PID 配合未变化的进程祖先，基线也失败。测试改为实际退出的子进程，生产 writer 证明没有放宽。合入后再次执行三个核心回归，退出 0，见 [merged-smoke.log](../evidence/ticket-agent-autonomy/deploy/merged-smoke.log)。

### 真实 Codex + 飞书 Topic

[real-run.json](../evidence/ticket-agent-autonomy/review/real-run.json) 保存本轮只读查询的节点结果、TaskRun Session、关键事件及原部署回执。移除了消息发送者身份和完整源 metadata，不包含凭据。

- 确认卡提案 `cmvgknqsv00017ozur253mlj0` 于 `2026-10-20T11:07:40.851Z` 获批。
- Run `cmvgkx5sr0002wsd7n5hf3v4z` 已 completed。
- T01 等待材料后收到真实话题消息“尺寸42，颜色蓝色”。`conversation_turn_scheduled` 记录 writerExited=true，revision 从 6 校验到 7，输入只绑定一次，未创建 Followup。
- T01 前后两个 TaskRun 共用平台 Session `cmvgkxaa109k7hp59bbggtv5p`，原生 Codex Session 均为 `01a158ff-039e-7863-8727-ae888f681760`。
- T01 于 `11:12:34.126Z` passed。T02 的首次实施于 `11:12:39.948Z` 开始，时间均为 UTC。
- T01 固定提交 `068df2821a5166bc19fe663e63a4cbbf61f8290f`。独立 Codex 复验记录实际输出 `42mm 蓝色`、跨进程重读及 15 项非法参数拒绝。
- T02 固定提交 `1eeeb502606d81b0daeab15f345ad2a0acdd4584`，于 `11:19:25.784Z` passed。独立复验记录 18 项检查，实际回执为 `{"label":"42mm 蓝色","sourceSize":42,"sourceColor":"蓝色"}`。

T02 用了原有两轮回修。它先忽略 `AP_GRAPH_OUTPUT_DIR`，第一次修正后又遇到新验收阶段目录中没有回执。最终验证入口优先读取阶段回执，仅文件不存在时读取仓内交付回执，并继续拒绝错误 JSON、字段和其他读取错误。这属于测试 consumer 的代码与验收路径问题，没有新增环境授权或重置预算。T02 三轮实施仍共用原生 Codex Session。

节点账本保存了验收摘要与当时输出路径。本轮尝试归档原始 `T01-review.json` 时，该临时路径已不存在，因此没有提交原始验收文件，也不把账本摘要称为独立重新复验。审查者可核对已提交的事件和固定提交；重跑请使用隔离环境。

本次真实路线只验证一次文字补料及后继放行，没有穷举图片补料、多用户越权、所有旧业务 Ticket 或运行中断场景。其他边界依据隔离回归，不能扩大为全生产验收通过。

## 部署状态与已知问题

四个服务均 active，飞书服务 PID 从 `946376` 切换为 `1751797`。网页健康检查及数据库检查通过。部署前后的原有 30 个 execution 对比一致，见 [核对记录](../evidence/ticket-agent-autonomy/deploy/existing-ticket-check.json)。该对比针对部署当时，不声称此后业务账本永不变化。

原始 cutover 回执仍是 `phase=failed`。它已记录服务切换、健康检查成功和完成时间，随后发送完成通知时因缺少 `FEISHU_APP_ID` 失败。通知 worker 的异常处理把整体 phase 改成 failed。应分别理解为部署成功、完成通知失败。此处保留原回执，不隐去错误；本轮没有顺手修改通知逻辑。

只为 `/data1/code/ap-autonomy-acceptance-20261020/label` 和 `consumer` 两个专用仓登记精确技能包授权。工作流测试群启用了已有话题隔离功能。私有宿主策略与原配置备份未提交到 Git，原业务项目条目未修改。测试路线采用独立测试仓，没有业务仓写权限。

## 请审查者重点看

1. 技能授权与挂载是否严格对应，完整包是否真的经过沙箱验证，attempt 资源固定是否仍能拒绝中途换版本。
2. continuation 的输入幂等、来源校验、TaskRun 归属、writer 退出证明和事务内 claim/revision 核对是否有竞争缺口。
3. 新普通等待是否走原实施入口，历史 Followup、已交付和验收中的只读行为是否继续受保护。
4. T02 两轮回修是否保留原预算，最终回执查找是否会误接受旧产物。
5. 终态节点仍保留的 progress.review/phase 历史字段是否会误导诊断；以节点 passed 和 Run completed 为此次终态证据。
6. 部署通知失败与整体部署 phase 混用是否应单独修复。

本轮到交接与推送结束。没有自动开展 S02、Gardening、Architect Inspector 或全仓重构。
