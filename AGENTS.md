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

### 2026-10-26 581 PLAN 的 HANDOVER 自动接续例外（最新）

用户在本私聊先要求恢复旧入口，随后明确“OK，继续”修改接续文档、确定消费起点并启用实测。
本例外只覆盖 `docs/581_PLAN_20261026_精简交付与可选验收手动计划.md` 及其后续交接，
优先于下面的手动规划、默认任务图和旧 watcher 停用条款；其他项目/旧票仍保持原执行方式。

- 本项目 watcher 可启用 `semi_auto`，审批与执行通知发到 Feishu DM 08a216。
  首次启用先核对无 pending、无排队/运行中的 watcher、Git 历史未改写，再把消费起点设在本次准备完成的 HEAD，
  明确选择 581 提审；跳过此前历史文档，不重放旧派发。保留启用前状态记录。
- 581 的首个 Slice 仍须由用户在真实 PLAN 审批卡批准，Agent 不得替用户批准或改写审批结果。
  本包选 `implement`：Codex 实施并自测，不派独立 reviewer/tester；不能省略测试。
- 每次只做一个 Slice，验证、追加提交并创建 HANDOVER 后结束当前 Session。
  S01/S02/S03 成功时使用 `next_slice`，Prompt 只指定下一 Slice；S04 完成使用 `await_acceptance`。
  未完成/阻塞时使用 `blocked` 并说明原因，禁止伪造完成或越过失败继续。
- 582 是开始 S01 前的准备交接，保持 `next_action: none`；不能冒充 S01 的完成证明。
- 本包不发布 Issues、不创建任务图路线，不恢复 M6/M07，不迁移旧快照、不部署业务修改。
  未指定验收者仍必须实施自测；显式独立验收才使用其他模型。

### 2026-10-26 精简交付与可选验收的手动规划例外

用户在 Feishu DM 08a216 要求按 antigravity 的阶段一、二写手动计划，开新 Session 实施。
入口为 `docs/581_PLAN_20261026_精简交付与可选验收手动计划.md` 和对应最新 HANDOVER。
未指定验收者默认不派独立验收，实施者仍须自测；明确指定独立验收时使用其他模型。
本轮只规划，不改生产行为或旧 M6 合同；旧文档中的同模型默认验收意见已被这次指令替代。
新 Session 按用户接续指令一次完成一个 Slice，验证、追加提交、写交接后停止。
PLAN/HANDOVER 使用 `next_action: none`，不发布 Issues、不启动自动路线或旧 watcher，不操作 cursor/pending。
本例外优先于下方新工作默认任务图规则；规划不授权重写已批准快照、恢复业务或部署。

### 2026-10-25 双通路与 M06 修复的手动规划例外

用户在 Feishu DM 08a216 明确要求本轮使用 Matt `to-tickets` 的纵向 Slice 方法，
将票写在 `docs/specs/manual-chat-task-graph/`，按
`docs/558_PLAN_20261025_双通路与M06纵向切片.md` 和最新 HANDOVER 手动接续。
本包不发布到 GitHub/Gitee 或其他 Issue tracker，不提审或启动自动任务路线。
此例外优先于下方新工作默认任务图规则；不改变其他任务的执行方式。
用户随后于同日明确要求开始 S01，完成后写交接，由新 Session 手动接续 S02。
S01 局部实施、测试、追加提交与交接已授权；本轮不启动 S02，不恢复 M06。
实施进度及后续授权在 PLAN/HANDOVER 正文记录。
PLAN/HANDOVER 保持 `next_action: none`，旧自动化保持关闭，不操作 cursor/pending。
用户未明确启用任务图时，手动主对话由聊天通路负责消息与卡片生命周期，
不得由任务图调度器接管；共用展示组件不代表共用调度归属。

### 本分支的手动交接例外

用户于 2026-10-23 在 Feishu DM 08a216 明确要求本次环境与阻塞修复改为手动执行，
分 Session 按 HANDOVER 接续，避免一次耗尽上下文。本例外仅适用于
`manual/s02-runtime-repair-20261023` 分支及
`docs/545_PLAN_20261023_运行环境修复手动执行.md`。

- 该 PLAN 内的局部编码和测试已获用户手动执行授权，不再等待新任务图路线卡。
- 每个 Session 读取最新 HANDOVER，只完成一个可验证单元，提交并写交接后停止。
  未完成的 Slice 必须记录剩余工作，下一 Session 仍继续该 Slice。
- PLAN/HANDOVER 使用现有文档合同及校验器，`next_action: none`；下一步写在普通正文，
  不使用自动 Prompt 标记或 `WORKFLOW_READY`。这表示不触发自动调度，不表示整项工作完成。
- `legacy.automation_enabled` 保持 false，不启用旧 watcher，不操作 cursor 或 pending。
- 此授权不恢复 S02/Reader/Mold，不变更旧票快照，不部署或中断生产 TaskRun。
- 本例外优先于下方默认规则中对新 PLAN/HANDOVER 的禁用；其他工作仍遵循任务图流程。

- 新工作使用经过讨论的原型、定稿 Spec 和依赖图定义纵向 Slice；参阅
  `docs/architecture/task-graph-workflow-spec.md`。人确认整条路线后，平台按依赖图派发，
  Agent 的提交、测试和验收证据写入执行账本。
- 父任务 Agent 按 `docs/agents/issue-tracker.md` 发布或导入 tickets，在 `docs/specs/<主题>/spec-package.json` 登记 `issueRoute` 执行配置；依赖直接从 Issues 读取。运行 `npm run task-graph:propose -- --parent-task-id=<任务ID> --spec-repository=<仓库> --spec-package=<包路径> --agent=<名称>`。包格式参见 `docs/architecture/issue-route-packages.md`。平台在父任务的飞书话题发送路线卡；人只在飞书卡片确认或退回。未确认的提议不得派发。
- 人可在父任务话题发送 `/ap graph propose [Spec 路径]`，或在 `/ap menu` 的「任务图 / Jobs」中点击「提出任务路线」，唤醒当前 Agent 准备并提交路线卡；`/ap graph status` 查询进度。
- 在确认卡前可用 `/ap graph role <Slice|all> <仓内任务键|acceptance|architecture> <Agent selector|automatic|human>` 改派实施者、验收者和架构复核者；`all architecture` 设置项目默认复核者。并行仓内任务可选择不同本机 harness。
- 不为新任务创建 PLAN/HANDOVER 接力文档，不使用 `next_action`、Prompt 标记或
  `WORKFLOW_READY` 启动下一 Session。任务图由父任务的飞书确认卡一次确认并启动；
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

## Feishu DM 08a216 的文档发送约定

用户于 2026-10-25 明确澄清：“贴出原文”是把原 `.md` 文件作为文件附件发到当前飞书私聊。
不要把全文贴进回复卡片，也不要转成独立长文本消息。发送后回读文件类型和文件名确认送达。
