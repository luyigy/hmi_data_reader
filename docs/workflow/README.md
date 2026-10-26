# PLAN/HANDOVER 工作流

2026-10-26 用户批准恢复本项目的 HANDOVER 接续入口。当前仅 581 计划及后续交接采用本路径，
配置为 `semi_auto`，首次 PLAN 经真实审批后实施，自测成功的 HANDOVER 接续下一 Slice。
审批与执行通知发到 Feishu DM 08a216。实施者按本包要求自测，未指定独立验收者时不派独立验收。

初始化消费起点前必须核对 pending、运行/排队状态及 Git 祖先关系；不得重放停用期间的旧文档。
其他项目与历史任务不因本次恢复被启用；任务图与 HANDOVER 不消费同一个任务结果。
规则见 [AGENTS](../../AGENTS.md) 的最新 581 例外及
[581 计划](../581_PLAN_20261026_精简交付与可选验收手动计划.md)。

新工作流设计见[任务图工作流规格](../architecture/task-graph-workflow-spec.md)。定稿 Spec 与依赖图决定执行顺序；执行账本记录提交、测试、集成和验收。Agent 在父任务提出路线，人在飞书确认卡上一次确认并启动。

本目录的[合同](./workflow-contract.yaml)、[操作指南](./AUTOMATION_GUIDE.md)、[PLAN 模板](./templates/PLAN.md)、[HANDOVER 模板](./templates/HANDOVER.md)与[原决策](./225_DECISION_20260725_文档自动化状态机.md)供本包接续使用，也保留历史审计材料；是否派发由项目开关、合同、审批和具体文档动作共同决定。
