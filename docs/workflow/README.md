# 历史 PLAN/HANDOVER 工作流

此目录记录已停用的文档接力方案。2026-10-15 起，`workflow-watcher` 的全部项目配置和运行时开关均关闭；本仓合同的 `legacy.automation_enabled` 也为 `false`。不要通过旧 PLAN/HANDOVER、`next_action` 或 `WORKFLOW_READY` 启动新任务。

新工作流设计见[任务图工作流规格](../architecture/task-graph-workflow-spec.md)。定稿 Spec 与依赖图决定执行顺序；执行账本记录提交、测试、集成和验收。父任务的任务图页面由人一次确认并启动路线。

本目录的[合同](./workflow-contract.yaml)、[操作指南](./AUTOMATION_GUIDE.md)、[PLAN 模板](./templates/PLAN.md)、[HANDOVER 模板](./templates/HANDOVER.md)与[原决策](./225_DECISION_20260725_文档自动化状态机.md)仅供查询历史工作和审计。旧派发入口与配置已关闭，历史文档仍可读取。
