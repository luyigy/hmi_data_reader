## Agent skills

For Matt Pocock's engineering skills, read the repository configuration in `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md`.

## GitNexus Usage

GitNexus is an available code analysis tool, but it should not be executed blindly for every task.

Use GitNexus only when the task requires deeper impact analysis, such as:

- modifying shared modules or public APIs;
- changing authentication, permission, database schema, workflow, or core architecture;
- performing large refactoring across multiple features;
- the dependency impact cannot be understood through normal code navigation.

For small, isolated changes:
- do not automatically run GitNexus;
- use normal repository exploration tools first;
- avoid unnecessary repository-wide analysis.

GitNexus results should support engineering decisions, not replace understanding of the actual code path.



## 任务图工作流

- 新工作使用经过讨论的原型、定稿 Spec 和依赖图定义纵向 Slice；参阅
  `docs/architecture/task-graph-workflow-spec.md`。人确认整条路线后，平台按依赖图派发，
  Agent 的提交、测试和验收证据写入执行账本。
- 不为新任务创建 PLAN/HANDOVER 接力文档，不使用 `next_action`、Prompt 标记或
  `WORKFLOW_READY` 启动下一 Session。任务图由父任务的任务图页面一次确认并启动；
  旧 watcher 不再派发。
- `docs/workflow/workflow-contract.yaml` 的 `automation_enabled` 已关闭。
  历史 PLAN/HANDOVER 保留为只读材料；如必须修复历史文档，仍按该合同校验，但不得重新启用派发。

## 长文件守卫

- 开工前运行 `npm run check:long-files`，确认当前已达阻断阈值的文件。
- 这些文件不得增长。需要新增职责时，先在同一提交中提取明确边界的模块。

## Workflow Git 历史

当提交已可能被 cursor、历史 PLAN/HANDOVER、审批卡或其他 Agent
读取后，Git 历史必须只追加：

- 不执行 `git commit --amend`、rebase、reset 或强推改写已提交历史。
- 对同一文件的后续修正必须创建新的 commit。
- 发现历史改写时，停止自动化并由人工确认/恢复 watcher cursor；Agent 不得猜测或自动恢复。
