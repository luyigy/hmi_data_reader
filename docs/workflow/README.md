# 工作流自动化入口

- 唯一机器可读规则源：[workflow-contract.yaml](./workflow-contract.yaml)
- 状态机决策背景：[225_DECISION_20260725_文档自动化状态机.md](./225_DECISION_20260725_文档自动化状态机.md)
- 自动化扫描边界：`docs/`
- 配置 Git ref：`refs/heads/oss-prep`
- watcher：计划在 `224_PLAN_20260725_通用项目定时任务平台.md` Slice 4 接入
- 状态与幂等账本：计划存入 Agent Platform PostgreSQL
- 调度：计划由 Slice 2 的独立 Job Runner 提供
- 当前状态：合同校验可用，自动消费关闭

watcher 只读取配置 ref 中已提交的 PLAN/HANDOVER blob。合同
`actions.executable` 中的 HANDOVER action 会立即重置 Session 并投递一次 Prompt；
PLAN 仍先等待人工审批，其他 action 只通知。无效合同停止并通知，不从正文猜测。

审批超时只告警并继续等待，不自动 reset。
