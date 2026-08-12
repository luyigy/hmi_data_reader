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



## 文档工作流

- `docs/workflow/workflow-contract.yaml` 是 PLAN/HANDOVER 自动化的唯一规则源。
- Agent 创建或修复 PLAN/HANDOVER 时读取合同声明的 `docs/workflow/templates/PLAN.md` 与
  `docs/workflow/templates/HANDOVER.md`；缺失时报告未初始化，不回退到平台内置模板。
- 新建 PLAN/HANDOVER 必须使用 `npm run workflow:new` 生成骨架，禁止手工创建结构；正文填写完成且
  `git add` 后必须运行 `npm run workflow:validate -- --preflight <文档路径>`。
- 新 PLAN/HANDOVER 必须使用合同定义的 YAML frontmatter、动作和 Prompt 标记。
- 自动化只读取目标 Git ref 中已提交的文档，不消费工作区文件，也不从正文猜测动作。
- `automation_enabled: false` 时只维护和校验文档，不启动 watcher 或下一 Session。
- 合同要求 `prompt.repeat_in_final_reply: true` 时，最终回复必须原样附上工作流文档 Prompt 标记之间的下一 Session Prompt，供用户直接复制。
- 可执行文档提交后，最终回复最后一行必须使用合同定义的 `WORKFLOW_READY` 标记。

## 长文件守卫

- 开工前运行 `npm run check:long-files`，确认当前已达阻断阈值的文件。
- 这些文件不得增长。workflow completion gate 会在工作流 participant 完成时校验并阻止继续完成；需要新增职责时，先在同一提交中提取明确边界的模块。

## Workflow Git 历史

当 workflow watcher 已启用，或提交已可能被 cursor、PLAN、HANDOVER、审批卡或其他 Agent
读取后，Git 历史必须只追加：

- 不执行 `git commit --amend`、rebase、reset 或强推改写已提交历史。
- 对同一文件的后续修正必须创建新的 commit。
- 发现历史改写时，停止自动化并由人工确认/恢复 watcher cursor；Agent 不得猜测或自动恢复。
