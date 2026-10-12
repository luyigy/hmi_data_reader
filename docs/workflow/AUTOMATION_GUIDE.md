# 工作流自动化接入与操作指南

## 1. 文档定位

本文解释 Agent Platform 当前已实现的 workflow 自动化。规则值、合法字段、动作、Prompt 标记、编号和阈值
只以目标 Git ref 中已提交的 [`workflow-contract.yaml`](./workflow-contract.yaml) 为准；本文不复制完整合同。

创建或修复 PLAN/HANDOVER 时，必须读取合同声明的
[`PLAN 写作与 Slice 划分规范`](./PLAN-writing-standard.md)、[`PLAN`](./templates/PLAN.md) /
[`HANDOVER`](./templates/HANDOVER.md) 模板。缺少合同、规范或模板时报告
“未初始化”，不得回退到平台安装目录中的隐藏副本。

## 2. 组件与事实边界

```text
已提交 PLAN/HANDOVER
        ↓
workflow-watcher → validator → 人工 PLAN 审批 / HANDOVER 动作
        ↓                              ↓
PostgreSQL cursor、pending、幂等账本   绑定 Live Room 中的新 Session
        ↓
TaskRun 完成事件即时唤醒 + 每分钟调度补偿
```

- 仓库保存合同、模板、PLAN/HANDOVER 和需求来源。
- Agent Platform 保存运行状态、审批状态、失败记录、Session 和外部消息标识。
- watcher 只读目标 ref 的 committed blob，不读取未提交文件。
- 自动化候选只包括合同声明的 `PLAN`、`HANDOVER`；REPORT/FIX/DECISION 等不会触发执行。
- 正常完成事件会即时唤醒 watcher；定时扫描负责漏事件和服务重启后的补偿。

## 3. 主状态机

### 3.1 PLAN

1. PLAN 使用 `doc_status: ready`，按用户意图选择动作：默认或备选方案使用 `await_approval`，
   多份 PLAN 可同时留在候选清单，不自动发审批卡；明确要求“写好后提审”时使用 `start_first_slice`。
2. `start_first_slice` 提交后直接由 watcher 进入审批；候选也可从 Dashboard 选择“提交审批”，
   或使用下方的 `job activate` 命令。watcher 校验合同、frontmatter、引用、Prompt、写作标准和编号。
3. 校验通过后导入文档并发送审批卡，持久化为 `pending`。
4. 审批选择：
   - 批准：运行态把动作转换为 `start_first_slice`，再按自治模式立即执行或等待人工运行 watcher；
   - 修改：只启动 PLAN 修订，不执行 Slice；
   - 拒绝：结束该候选；
   - 超时：审批卡过期后可重发，不自动批准。
5. 执行时只把合同标记之间唯一且非空的 Prompt 投递到绑定 Live Room。

新 PLAN 永远需要人工审批。`start_first_slice` 在未批准的 PLAN 上表示申请首个 Slice 审批，
不会跳过审批直接执行。`auto` 只负责生成提案，不拥有批准权。

在对话中要求“把刚才那个 PLAN 提审”时，Agent 按写作规范定位唯一文档、修改动作、校验并单独提交。
多个候选需要指定选择时，可直接在项目绑定的飞书会话发送已有命令，无须先打开 Dashboard：

```text
/ap job activate workflow-watcher --plan=<仓库相对PLAN路径> --head=<当前监控ref的40位HEAD>
```

该命令与 Dashboard 共用权限、HEAD 和候选校验；已有 pending 或正在运行时先处理当前任务。
watcher 停用或合同 `automation_enabled: false` 时不会自动发卡，不得为了提审自行启用自动化。
watcher 按变更中文档编号选择候选，多个候选应使用上述指定路径的选择入口，不能保证每份提交都会发卡。

HTML PLAN 试点可用 `npm run workflow:new -- --kind plan --title <主题> --format html` 生成。
目前只支持 phase 候选；生成器和校验器识别 `.html`，watcher 仍只派发正式的 Markdown PLAN。
请勿把 HTML 候选当作已进入审批的计划。普通 HANDOVER 继续使用 Markdown。

### 3.2 HANDOVER

| HANDOVER 动作 | 含义 | 后续 |
| --- | --- | --- |
| `next_slice` | 当前 Slice 完成，Phase PLAN 仍在进行 | 投递下一 Slice Prompt |
| `resume_parent` | Interrupt PLAN 完成 | 恢复父 PLAN 的 `return_to` Slice |
| `await_acceptance` | Phase PLAN 完成 | 通知验收；`auto` 可继续提议下一 PLAN |
| `blocked` / `none` | 无可执行推进 | 通知并停止 |

Agent 必须先提交 HANDOVER，取得最后一次变更的 commit SHA，再结束 Session。completion gate 统一检查新增或
修改的 workflow 文档已提交且通过合同校验，并阻止已达阈值的长文件继续增长。合同与 `AGENTS.md` 还要求：
最终回复原样重复下一 Session Prompt，并以 `WORKFLOW_READY` 标记结束。

## 4. 自治模式

`workflow-watcher` 的启停与自治模式是两个独立控制面。watcher disabled 时，任何自治模式都不会定时扫描。

| 模式 | 已批准 PLAN S01 | `next_slice` | `resume_parent` | Phase 完成后 Roadmap/Inbox |
| --- | --- | --- | --- | --- |
| `manual` | 手工运行 watcher | 手工运行 watcher | 手工运行 watcher | 不提议 |
| `semi_auto` | 自动 | 自动 | 停止，等待人工 | 不提议 |
| `auto` | 自动 | 自动 | 自动 | 自动生成待审批 PLAN |

手工 `/ap job run workflow-watcher` 可以推进当前合法动作，不受自治模式的定时推进限制。任何模式都不会越过
`blocked`，也不会自动批准 PLAN。

项目配置中的模式只是默认值；数据库 override 优先。无效 override 会安全回退为 `manual`。切换模式必须携带
当前 40 位 HEAD，避免基于过期仓库状态改变执行策略。

## 5. Roadmap 与 Git Inbox

`auto` 只在以下条件同时成立时提议下一 PLAN：

- 当前文档是 `plan_progress: complete + next_action: await_acceptance` 的 HANDOVER；
- HANDOVER 引用的是 Phase PLAN，不是 Interrupt PLAN；
- 项目 ref 是本地已检出的 `refs/heads/*`，HEAD 在选择和提交期间未变化；
- 同一仓库、ref、branch space 只有一个 workflow consumer。

候选顺序：

1. Phase PLAN 的 `roadmap` 非空时，读取该 ROADMAP 第一条未勾选项；Roadmap 没有未完成项就停止，不回退 Inbox。
2. `roadmap: null` 时，按 Git tree 扫描 `docs/inbox/` 直属 Markdown（忽略 `README.md`）。
3. 跳过已经被 `WORKFLOW_INBOX_ITEM` 标记认领的条目，取第一个未认领项。
4. 自动创建并提交一份新的 Phase PLAN；下一轮 watcher 进入正常 PLAN 审批。

Inbox 是已提交需求池，不是可执行 PLAN 目录。推荐每项一个 `ISSUE`：

```text
/ap inbox add "需求标题" --body="范围与验收目标" --head=<当前40位HEAD>
```

该命令只创建并提交 `draft + next_action: none` 的 ISSUE，不会改变自治模式或立即执行需求。当前消费者不会按
Inbox frontmatter 状态过滤候选，因此不想被领取的文件应删除、移出 Inbox，或在启用 `auto` 前人工整理；不要
把草稿、历史说明或正式 PLAN 放在 Inbox。

## 6. Git、cursor 与幂等

- 事件身份由 commit、文档路径、blob 和 action 共同确定；相同事件不会重复执行。
- watcher 扫描本轮变更中编号最高的候选文档；`await_approval` PLAN 留在清单，明确选择后审批；`start_first_slice` PLAN 直接进入审批。
- cursor 记录已消费位置；pending 记录审批或待执行 PLAN。两者都在数据库中，不写入仓库。
- watcher 已读取或可能读取提交后，Git 历史必须只追加。禁止 amend、rebase、reset 和强推改写历史。
- 检测到 ref 改写、cursor 早于合同 cutoff、HEAD 竞争或 consumer 冲突时，自动化停止并要求人工判断。
- 移动 cursor 或清除 pending 会改变恢复语义，只能在 diagnose 后显式执行，Agent 不得猜测恢复点。

## 7. 校验、失败与恢复

- `balanced`：启用的策略规则产生 warning；结构、动作、引用和调度安全问题仍是 error。
- `strict`：启用的策略规则也提升为 error。
- 校验失败时不执行文档；首次通知后仍失败的同一 blob 会被隔离并前移 cursor，修复后重新提交形成新事件再校验。
- PLAN 审批 pending 可重发；修改意见只修订 PLAN，不开始实施。
- watcher blocker 会保留 cursor，并可请求 Coding Agent 处理安全范围内的问题；移动 cursor 或修复历史仍需人工确认。
- 服务重启会对遗留 Scheduled Job / TaskRun 状态做恢复，随后由即时事件或定时扫描继续。

常规排查顺序：先看状态，再只读诊断，最后才做恢复写操作。

```text
/ap workflow status
/ap workflow autonomy show
/ap dashboard
/ap job diagnose workflow-watcher
/ap job run workflow-watcher
/ap job cursor workflow-watcher --latest
/ap job cursor workflow-watcher --clear-pending
```

`--latest` 和 `--clear-pending` 不是常规“重试”按钮，必须先确认 cursor、pending、目标 HEAD 和 Git 历史。

## 8. 常用操作

```text
# 仓库内校验
npm run workflow:validate -- HEAD docs/<编号>_PLAN_<日期>_<主题>.md [docs/<编号>_HANDOVER_<日期>_<主题>.md]
npm run check:long-files

# watcher
/ap job enable workflow-watcher
/ap job disable workflow-watcher
/ap job run workflow-watcher
/ap job diagnose workflow-watcher

# 自治模式
/ap workflow autonomy show
/ap workflow autonomy set manual --head=<当前40位HEAD>
/ap workflow autonomy set semi_auto --head=<当前40位HEAD>
/ap workflow autonomy set auto --head=<当前40位HEAD>
```

Workflow Dashboard 已覆盖刷新、启停、立即运行、停止、审批卡重发、验证修订和三种自治模式切换。cursor 移动、
清除 pending 等高影响操作保留为显式命令。

## 9. 维护规则与代码入口

更新规则时按职责修改，不重复维护：

- 合法字段、动作、模板路径、编号、阈值：`docs/workflow/workflow-contract.yaml`
- 合格示例：`docs/workflow/templates/PLAN.md`、`HANDOVER.md`
- 人类流程说明：本文与本目录 README
- 历史决策：`docs/workflow/225_DECISION_20260725_文档自动化状态机.md`
- 操作验收证据：编号 REPORT；缺陷根因与验证：编号 FIX

主要实现入口：

- `src/lib/scheduled-jobs/workflow-watcher.ts`：扫描、校验、审批门、执行与终止动作
- `src/lib/scheduled-jobs/workflow-autonomy.ts`：自治模式判定
- `src/lib/scheduled-jobs/workflow-roadmap-inbox.ts`：Roadmap/Inbox 选取与 PLAN 提案
- `src/lib/scheduled-jobs/workflow-validator.ts`：合同解析与文档校验
- `src/lib/scheduled-jobs/workflow-status.ts`：状态与唯一下一步
- `src/lib/scheduled-jobs/workflow-inspection.ts`：Dashboard 队列与文档检查
- `src/lib/scheduled-jobs/git-history-guard.ts`：只追加历史保护
- `src/lib/acpx/workflow-completion-gate.ts`：Session 完成门
- `src/lib/feishu-workflow-policy.ts`：飞书自治模式和权限操作
- `src/lib/feishu-scheduled-jobs.ts`：Workflow Dashboard 与 Scheduled Job 命令

修改实现后运行对应的 `test:workflow-*` 聚焦测试；提交前运行 GitNexus `detect_changes()` 核对影响范围。
