---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S08
plan_progress: in_progress
---

# HANDOVER · Workflow 故障注入 S08 Bot 验收阻塞交接

## 已完成

- S08 离线故障注入与幂等恢复测试已由提交 `414cf47` 完成，生产代码、数据库 schema 和公共 API 未修改。
- 只读检查确认共享 PostgreSQL 已应用仓库内全部 25 个 migration，因此没有执行 migration deploy。
- 经用户授权重启 `agent-platform-dev.service`、`agent-platform-feishu.service` 和
  `agent-platform-scheduled-jobs.service`；三个服务均恢复 active，重启后的 warning..alert 日志为空。
- 唯一试点保持为当前仓库 `agent-platform-v2`、分支 `oss-prep` 和其既有 Feishu chat；未触及其他项目。
- 按用户最终限定，仅以 Bot 身份发送一条明确标注、不含 `/ap` 命令的 S08 投递探针；发送成功且未模拟
  用户操作。

## Bot-only 验收边界

- 用户明确拒绝授予 `im:message.send_as_user`，后续不得申请该 scope，也不得以用户身份发送消息。
- 已放弃未完成的增量授权流程并删除本次临时二维码；没有轮询 device code，没有改变或注销机器上原有的
  用户登录态。
- Bot 读取试点群消息历史被 Feishu 以错误 `230027` 拒绝。未按错误提示改走用户授权，也未扩大 Bot 权限。
- Bot 自发消息不能证明真实用户入口可用，且不能代替用户触发 `/ap` 命令、点击 Handoff/审批/new-session
  确认卡或产生可信回调。

## 未执行

- 未以用户身份发送任何消息，未伪造卡片回调。
- 未执行真实 Handoff 讨论提升、审批修改/拒绝/批准、手工启动或 new-session 确认。
- 未切换试点 workflow autonomy；配置仍为既有 `semi_auto`。
- 未执行 `manual → semi_auto → auto → manual` 的真实渐进验收，未扩大试点范围。

## 当前阻塞

PLAN S08 的真实 Feishu E2E 要求真实用户命令和交互卡操作。Bot-only 权限无法满足该完成标准，因此 S08
保持 `plan_progress: in_progress`、`next_action: blocked`，不得创建 `await_acceptance` 终态 HANDOVER。

## 恢复条件

仅在用户本人愿意在试点 Feishu 会话中执行测试命令和点击测试卡时恢复；这不要求 Agent 获得
`im:message.send_as_user`。恢复后先确认三个服务健康和 autonomy 现状，再由用户完成 manual 阶段交互，
随后逐级验证 semi_auto、单项目 auto 并降级 manual。任一步骤失败立即停止，不得由 Bot 冒充用户补做。

## 验证

- Bot 探针发送：成功。
- Bot 历史读取：失败，Feishu 错误 `230027`；作为权限边界证据保留。
- 其余代码测试、TypeScript、ESLint、long-file guard、Git diff 和 GitNexus 结果见提交 `414cf47` 及本次
  提交前验证。

## 非自动化恢复提示

blocked HANDOVER 不包含 workflow Prompt 标记。恢复 S08 时读取本 HANDOVER、原 PLAN、workflow contract
和目标 HEAD 的 `AGENTS.md`；严格保持 Bot-only 身份，所有真实用户命令与卡片点击必须由用户本人完成。
