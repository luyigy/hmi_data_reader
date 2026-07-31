---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow 三模式、Session 治理与计划审批执行

## 目标

把现有 Task Room、PLAN/HANDOVER、审批卡、workflow watcher、Session continuation 和 provider
遥测收敛成一套可预测的工作流：

- 先解决 Validator 反复阻塞：只有已证明的危险文档转换被拦截，Validator/依赖/Git 运行故障不得冻结提交、
  其他项目或后续有效事件；
- 用户随时能看到当前 Workflow 状态；完成、重试、隔离和阻塞都必须说明发生了什么、影响什么、如何恢复；
- 支持 `manual / semi_auto / auto` 三种自治模式；
- 所有新 PLAN 都必须经用户审批，Auto 也不能绕过审批；
- 普通 Live Room handoff 讨论可由用户显式提升为正式 PLAN，并复用现有审批卡启动实施；
- 工作流推进与 Session 换代解耦，只在工作单元边界依据可信上下文水位安全换代；
- PLAN 完成后，Auto 可回父 PLAN，或从 Roadmap/Inbox 提议下一项，但新 PLAN 仍等待审批；
- Validator 只阻止危险状态转换，平台故障和普通草稿问题不得冻结整个工作流；
- 服务重启、重复事件和失败都能恢复或明确通知用户，不再静默停住。

本计划复用现有 PLAN/HANDOVER 合同、审批回调、`WorkflowDispatch` checkpoint、TaskSession、
provider telemetry、Live Room handoff 和 Feishu 卡片，不新建第二套通用工作流引擎。

## 已确认事实

- 当前已有 PLAN 审批、修改/拒绝/批准、首 Slice 启动、dispatch 幂等 checkpoint 和重启恢复能力。
- 当前 workflow 派发仍把“推进下一动作”和 `new-session --all --blank` 绑定；每次动作前可能无条件换
  Session。
- Codex 与 Kimi 已有可按 freshness 和 Session ID 校验的 provider context usage；account quota 与
  context usage 是不同信号，换 Session 不会恢复账户额度。
- Kimi continuation 会保留同一 Session；只有 blank Session 才释放上下文。Antigravity 当前每轮新
  conversation，不适用自身跨轮 Session rotation，但其单次输入仍可作为房间水位证据。
- 消息数、事件数和 transcript 字符数只是平台代理信号，不能冒充真实上下文百分比。
- `/ap new-session` 已支持 Handover，但手工切换前没有统一的 dirty workspace、未完成 PLAN 和交接确认门。
- 普通 `$member` handoff 已能完成讨论，但缺少“将本轮讨论提升为正式 PLAN”的显式入口。
- ROADMAP 当前不是可执行队列；它可以先作为 Git 中的 Inbox，由持久化 event key 防止重复提议。
- Validator、completion gate、append-only guard 和 watcher 已有一组未提交的安全修复；S01 必须先辨认、
  验证并精确收口，不能覆盖或夹带其他工作区改动。
- `docs/332_HANDOVER_20260731_LiveRoomHandoff自循环修复.md` 已完成普通回复停止自动接力的修复和真实
  验收，不属于本计划实施范围。
- `docs/334_HANDOVER_20260731_Antigravity真实上下文水位及StreamJson遥测完成.md` 记录的是此前
  `null / not_applicable` 实现状态；本 PLAN 已确认的新决策覆盖其后续目标，但不改写历史交接记录。
- 开工前 `npm run check:long-files` 通过，没有达到 1000 行阻断阈值的源码。

## 语义合同

### 1. 三种自治模式

自治模式控制“谁可以推进下一工作流动作”，不控制模型 Session 是否换代。沿用现有 Room
`discussion / execution / hybrid` 模式，不复用或改写其语义。

| 行为 | `manual` | `semi_auto` | `auto` |
| --- | --- | --- | --- |
| 讨论并生成 PLAN | 用户发起 | 用户发起 | 可从父 PLAN/Roadmap 提议 |
| PLAN 审批 | 必须 | 必须 | 必须 |
| 审批反馈后的 PLAN 修订 | 用户再次触发 | 自动组织 | 自动组织 |
| 已批准 PLAN 内推进 Slice | 用户逐步触发 | 自动推进 | 自动推进 |
| PLAN 完成后 | 停止 | 停止并提示下一项 | 回父 PLAN，否则提议 Roadmap/Inbox 下一项 |
| 新 PLAN 首 Slice | 审批后由用户触发 | 审批后自动启动 | 审批后自动启动 |
| 达阈值后的 Session 换代 | 用户确认 | 提示并确认 | 平台安全换代 |

- 默认必须安全兼容：未配置项目为 `manual`；当前已启用自动 workflow 的项目在迁移时显式映射为
  `semi_auto`，不得静默升级为 `auto`。
- `auto` 只自动准备和推进已批准工作；任何新 PLAN 都必须等待用户审批。
- 用户可随时降级到 `manual`；降级只阻止后续自动动作，不中断正在执行的原子工作单元。

### 2. Session 换代

- 决策只发生在派发新工作单元前，单个运行中的长 TaskRun 永不中途强切。
- 房间水位取所有在线、当前工作相关 Agent 的有效水位百分比最大值；不同模型先各自除以 context window，
  不比较 Token 绝对值。
- Codex/Kimi 使用新鲜且 Session 匹配的 provider usage；Antigravity 使用最近一次运行的
  `input_tokens`，已知模型使用模型映射，未知模型统一以 `1,048,576` 为估算分母并标注 `1M assumed`。
- 水位动作：
  - 约 65%：准备紧凑 Handover，提示 Agent 收束当前原子步骤；
  - `>= 70%`：进入房间 rotation/handoff pending；
  - `>= 85%`：提高用户可见告警优先级，但仍只在安全工作单元边界换代。
- telemetry 缺失、过期、Session 不匹配或为 `unknown` 时只提示，不自动换代。
- Antigravity 参与房间最大水位与告警；因其每轮已是新 conversation，不单独执行 `/ap new-session`，达到
  阈值时执行的是房间 Handover/输入收束策略。
- 其他 provider 的消息/事件/transcript 阈值只作可配置诊断提示；默认值须由现有运行样本校准，不得直接
  沿用 60 条/400 个事件/4000 字作为自动换代条件。
- 自动换代必须使用已提交 Handover 和相同 working directory；不得用 account quota 触发。

### 3. Handover 与工作区安全

换代前的紧凑 Handover 只记录：

- PLAN/Slice、目标和未完成项；
- 已验证事实、测试结果和当前 Git HEAD；
- staged、unstaged、untracked 成果的可恢复状态；
- 下一 Session 的恢复命令和 Handover 路径。

Agent 只能提交本阶段明确产生的文件，不能夹带用户已有改动。二进制、敏感内容或无法安全记录的 dirty
成果必须阻断自动换代并通知用户；不得为了换 Session 制造虚假完成提交。

### 4. Validator

- 单一 Validator 必须返回可判定的三类结果，不允许靠错误字符串猜分类：
  - `valid`：允许提交并按动作继续；
  - `document_invalid`：已证明文档违反合同；仅 executable action fail closed；
  - `runtime_unavailable`：Validator 崩溃、依赖缺失、超时或 Git/ref/合同读取失败；允许普通 Git 提交，
    但暂停该 executable dispatch、告警并重试。
- `draft + none` 只做 soft lint，可提交、可导入飞书、可反复修订；soft lint 不进入纠错 Session。
- 只有进入 executable action（`start_first_slice / next_slice / resume_parent`）时运行 hard gate。hard gate
  只保护：YAML/合同可解析、引用和动作合法、可执行动作有唯一 Prompt、目标 HEAD 匹配、Git 历史只追加、
  长文件不得增长。
- Git hook 只阻止明确的 `document_invalid`，不得因 Validator 无法启动而锁死开发提交；watcher 仍不得在
  未完成 hard gate 时执行危险动作。
- watcher 以 `path + blob` 作为失败身份：首次失败通知并等待原 Session 修正；同一 blob 再次失败后隔离并
  前移游标，使后续有效提交继续处理；修复后产生的新 blob 必须重新校验。
- completion gate 只处理当前 Run 修改的文档，纠错次数有界；失败后写 `blocked`，不得无限创建 Session 或
  反复让 Agent 提及自身。
- runner 启动、hook 安装和项目扫描按项目隔离；一个仓库故障不能阻止其他仓库运行。
- PLAN/HANDOVER 生成器直接产出合同合格的 frontmatter 和 Prompt，减少事后纠错。

### 5. Workflow 状态与完成可见性

复用现有 workflow checkpoint、watcher cursor、审批状态和 TaskSession 作为事实源，只构建一个只读状态
投影，不新增第二套状态机。任何自动动作必须进入以下之一：

- 已完成并记录 checkpoint；
- 等待审批/人工动作，并显示唯一下一步；
- 可重试且展示下一次重试时间和恢复状态；
- 已隔离但不影响后续事件；
- `blocked` 并给出原因、影响范围和用户可执行动作。

Feishu 状态卡、`/ap workflow status`、Web Dashboard 和 Task Room 时间线必须展示同一组最小字段：

- 项目/ref/当前 HEAD、自治模式；
- 当前 PLAN、Slice、动作和阶段；
- 审批状态、执行 Session、Handover/rotation 状态；
- Validator 结果类别、受影响文档和 commit；
- 最后成功动作、最后错误、是否重试或隔离；
- 一条明确的用户下一步：按钮、命令或需修复的文件。

Workflow 到达 `completed` 后必须主动发送完成回执，列出完成的 PLAN/Slice、交付 commit、实际通过的验证、
HANDOVER/验收入口、遗留风险，并明确显示“已停止自动推进”或“下一 PLAN 等待审批”。不得仅写服务日志、
仅显示绿色 `done`，也不得让用户从原始 Validator stack trace 推测修复方法。

## S01：在途安全修复与基线收口

先辨认开工前未提交的 workflow validator、watcher、completion gate、runner、Git history guard 和测试
改动，只收口本轮讨论中已经完成的安全修复：

1. runner 单项目启动故障隔离；
2. `valid / document_invalid / runtime_unavailable` 分流，Git hook 只拦截已证明的文档错误；
3. 同一无效 `path + blob` 首次通知、再次失败隔离并受控前移；
4. dirty workflow 文档进入原 Session 的有界纠错闭环；
5. append-only Git 历史保护及无 shell `awk` 依赖的可移植校验。

不得在 S01 实现自治模式、Session rotation、Roadmap 自动领取或新审批入口。若当前工作区实现与上述合同
不一致，只修根因和对应最小测试；无关改动保持原样。

完成标准：

- validator、watcher、completion gate、scheduled runner、Git history guard 聚焦测试通过；
- Validator 运行时故障允许普通提交但不执行未校验动作；真实 executable 文档错误仍 fail closed；
- 同一坏 blob 不产生永久循环，后续有效提交仍可处理；
- 每类失败至少有一条包含分类、影响范围和恢复动作的去重通知测试；
- `npx tsc --noEmit`、相关 ESLint、`npm run check:long-files`、`git diff --check` 通过；
- 运行 GitNexus `detect_changes({scope: "compare", base_ref: "master"})`；
- 精确提交 S01 文件并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER。

## S02：Workflow Status、阻塞诊断与完成回执

1. 从现有 checkpoint、cursor、审批和 Session 数据计算统一 `WorkflowStatus` 只读投影，不复制状态。
2. 提供 `/ap workflow status` 和现有 Web/Feishu 状态入口，显示语义合同列出的最小字段。
3. 将 Validator 失败转换为面向用户的结构化诊断：错误类别、文件/commit、是否阻塞其他事件、自动重试状态
   和唯一修复动作；原始错误保留在详情中。
4. 为 `awaiting_approval / running / retrying / quarantined / blocked / completed` 提供去重通知；只有状态或
   错误指纹变化才再次发送。
5. 完成回执必须区分“Slice 已完成”“PLAN 已完成待验收”“已完成并将自动回父 PLAN”“新 PLAN 等待审批”，
   避免用户误以为系统仍在运行或不知道下一步。

完成标准：

- 同一事实状态在 Feishu、命令和 Web 上的核心字段一致；
- 用户仅看状态卡即可判断当前阶段、阻塞范围和唯一下一步；
- 完成回执包含 commit、已运行验证、HANDOVER/验收入口和自动推进状态；
- 重启、重复 watcher 和重复回调不重复刷屏；
- 不新增第二套状态机、事件总线或通用通知框架。

实施状态（2026-07-31）：S02 已完成。统一只读投影、飞书命令与卡片、Web 页面、Validator
分类、唯一下一步和幂等完成回执见
`docs/336_HANDOVER_20260731_WorkflowStatus可见性S02交接.md`；未开始 S03。

## S03：自治模式合同、持久化与控制面

1. 增加独立的 `workflowAutonomy = manual | semi_auto | auto`，不修改 Live Room `mode`。
2. 以项目 workflow 配置为唯一默认值；Feishu/Task Room 只修改当前绑定项目。
3. 提供最小查询/切换入口并接入 S02 状态投影；权限复用现有项目/Feishu 管理权限。
4. 模式切换写入持久状态并带预期 Git HEAD；重复卡片回调和重复命令必须幂等。
5. 降级到 `manual` 后，未开始的自动动作停止；正在运行的原子工作单元正常收口。

完成标准：

- 三种模式的推进矩阵有单元测试；
- 既有自动 workflow 项目显式迁移为 `semi_auto`，其他项目为 `manual`；
- 非管理员、未绑定项目、过期卡片和重复回调 fail closed；
- 不新增通用工作流引擎；相关检查和 GitNexus 变更核验通过。

## S04：普通 Handoff 讨论提升为审批 PLAN

复用现有 `/ap plan`、workflow contract、PLAN 审批卡和 watcher：

1. 用户显式选择“将本轮讨论生成审批 PLAN”后，主持 Agent 综合当前根 handoff 链，不重新发起讨论。
2. 生成唯一、合同合格的 `draft` PLAN，导入/展示为飞书文档并发送现有审批卡。
3. 用户修改、拒绝、批准继续走现有审批回调；批准时执行 hard gate 并转换为
   `ready + start_first_slice`。
4. 重复点击、重复回调、服务重启只能形成一份 PLAN、一个当前审批轮次和一次首 Slice 启动。
5. `manual` 审批后等待用户启动；`semi_auto/auto` 审批后自动启动。未经批准绝不实施。

完成标准：

- 一次真实 handoff transcript fixture 可生成唯一 PLAN；
- 计划文档链接、审批卡、修改意见和批准启动端到端使用既有链路；
- 不新增 `PlanRegistry`、第二套审批状态机或从自由文本猜执行意图；
- 普通聊天、directed visible、handoff 和 `/ap plan` 既有行为无回归。

## S05：工作流推进与 Session 换代解耦

1. 删除“每个 executable workflow action 都先 blank reset”的无条件绑定。
2. 保留 `WorkflowDispatch.eventKey` 与
   `prepared → session_reset/rotation → feishu_posted → prompt_posted → reply_queued` 的幂等恢复语义；
   未发生换代时明确记录 `rotation_not_required`，不能靠缺字段猜测。
3. 手工 `/ap new-session` 在存在运行/排队任务、dirty workspace、未完成 PLAN 或缺少 Handover 时发送确认卡：
   - 生成 Handover、提交后切换；
   - 直接切换；
   - 取消。
4. `manual/semi_auto` 的自动建议需用户确认；`auto` 才可按 S06 策略自动进入安全换代。
5. TaskSession 存在不等于 rotation 完成；bootstrap/handover prompt、thread 清理和新 Session 绑定必须有
   可恢复 checkpoint。

完成标准：

- 连续两个 Slice 在水位安全时复用原 Session；
- 手工切换确认卡覆盖 dirty、running、无 Handover 和取消路径；
- reset/rotation 中任一步骤崩溃后只补剩余副作用；
- 不重复停止、建 Session、发 prompt 或启动 delivery。

## S06：房间最大水位与平台托管安全换代

1. 在新工作单元派发前计算在线且当前工作相关 Agent 的最大水位：Codex/Kimi 使用与当前 Session 匹配且
   新鲜的 context usage；Antigravity 使用最近一次运行 input tokens，未知模型使用 `1,048,576` 分母。
2. 实现 65% checkpoint 准备、70% rotation pending、85% 高优先级告警；阈值可由项目配置调整，默认值
   保持上述合同。
3. rotation 首个动作必须用当前 workflow `eventKey` 原子 claim；claim 前禁止 stop/reset/start。
4. 安全顺序为：
   - 收束原子步骤并提交真实成果；
   - 提交紧凑 Handover；
   - claim `rotation_pending`；
   - 停止旧 Session；
   - 以相同 working directory 和 `--handover` 启动 blank Session；
   - 完成 bootstrap/binding 后标记 `rotation_completed`；
   - 恢复工作单元派发。
5. `unknown` 和代理信号只提示；Antigravity 水位可触发房间 Handover，但不得对 Antigravity 自身执行
   `/ap new-session`。

完成标准：

- 多 Agent 取最大比例、Codex/Kimi freshness、Session 匹配、Antigravity 1M fallback、阈值边界、
  配置覆盖和 unknown 降级测试通过；
- Kimi 换代后不续用旧 Session，working directory 与 Handover 保持一致；
- Antigravity 参与房间告警但不执行无意义的自身 rotation；
- account quota、普通 Room payload 和 context rotation 保持隔离。

## S07：Semi-auto / Auto 推进与 Roadmap/Inbox

1. `semi_auto` 只自动推进已批准 PLAN 内的下一 Slice；PLAN 完成后停止并提示。
2. `auto` 完成 interrupt PLAN 后按 `resume_parent` 返回父 PLAN；phase PLAN 完成后读取关联 Roadmap/Inbox。
3. 第一版 Roadmap 只作为 Git Inbox：
   - 选择未完成、未被现有 PLAN 认领的一项；
   - 记录候选条目、预期 HEAD 和唯一 event key；
   - 生成新 PLAN 并发送审批卡；
   - 审批前停止。
4. 多房间同时消费同一 Inbox 的并发场景未证明安全时 fail closed；只有出现真实并发需求再增加最小
   claim/lease，不预建通用队列。
5. 用户拒绝、切回 manual、HEAD 改变或父引用失效时停止自动推进并通知。

完成标准：

- Manual 不自动推进；Semi-auto 只在当前批准 PLAN 内推进；Auto 可回父计划并提议下一 PLAN；
- 重复 watcher、重复卡片和服务重启不重复领取条目或创建 PLAN；
- 新 PLAN 始终需要用户审批；
- 2–3 个隔离项目覆盖无 Roadmap、空 Inbox、父 PLAN、interrupt 和 HEAD 变化。

## S08：故障注入、真实 Feishu 验收与渐进上线

使用隔离数据库、fake sender 和可控进程故障覆盖：

- HANDOVER commit 后、rotation claim 前；
- rotation pending 后、停止旧 Session 前；
- stop 请求后、状态落库前；
- 旧 Session 停止后、新 TaskSession 创建前；
- TaskSession 创建后、bootstrap/binding 完成前；
- 新 Session delivery 后、rotation complete 前；
- complete 后、watcher cursor 保存前；
- 审批卡发送结果未知、重复回调、服务重启和 Git HEAD 变化。

每个注入点必须证明：只补剩余步骤，不重复外部副作用；无法证明时进入 `blocked` 并通知。

上线顺序：

1. 先以 shadow/read-only 方式上线 Validator 分类和 Workflow Status，注入坏文档、Validator 崩溃、重复事件
   和完成事件，确认不会锁死 Git、不会吞后续事件、用户能独立判断修复动作；
2. 再启用 `manual`，完成真实 Feishu 的讨论提升、审批、修改、批准、手工启动和安全 new-session 验收；
3. 小范围启用 `semi_auto`，验证跨 Slice continuation、70% rotation 和重启恢复；
4. 最后对单个试点项目启用 `auto`，验证父 PLAN/Roadmap 提议；
5. 保留一键降级 `manual`，观察重复派发、恢复成功、上下文恢复和静默失败指标后再扩大范围。

计划终态完成标准：

- 三种模式状态机和权限边界均通过；
- 普通 handoff 讨论可生成审批 PLAN，并由用户批准后按模式实施；
- workflow 推进不再无条件换 Session；
- 换代前 Handover/提交、可信遥测和逐步恢复闭环有效；
- Roadmap/Inbox 不会绕过审批或重复领取；
- Validator 不再成为平台故障放大器，危险转换仍被阻止；
- 所有失败、隔离、等待和完成状态用户可见，并给出唯一下一步；
- 真实 Feishu E2E、TypeScript、相关 ESLint、聚焦/回归测试、long-file guard、
  `git diff --check` 和 GitNexus staged/compare 变更核验通过；
- 创建 `plan_progress: complete`、`next_action: await_acceptance` 的 S08 终态 HANDOVER 后停止。

## 风险与控制

- **共享执行链：** watcher、completion gate、new-session、dispatch 和 Live Room delivery 影响多个入口；
  每个 Slice 修改任一 function/class/method 前必须运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。
- **双控制面：** 新旧推进路径不能同时产生副作用；迁移期以同一 event key claim，无法唯一判定 owner 时阻断。
- **外部副作用未知：** 卡片/Session/prompt 发送结果无法证明时保持 blocked，不盲目重发。
- **上下文误判：** Codex/Kimi 使用可信 provider usage；Antigravity 的 1M fallback 必须显式标注为估算。
  account quota 和消息/事件/transcript 代理指标不参与百分比计算。
- **工作区保护：** 每个 Slice 精确提交自己的文件；不得清理、覆盖或夹带开工前用户改动。
- **Git 历史：** watcher 已启用或文档已被读取后只追加提交；禁止 amend、rebase、reset 和 force push。
- **长文件：** 开工前及每个 Slice 结束运行 long-file guard；已有长文件不得增长，新职责优先放在现有明确
  owner 模块，避免再建一层通用框架。
- **外部动作：** 未经用户在对应 Slice 明确授权，不重启真实服务、不发送真实 Feishu 消息、不修改生产
  数据；S08 真实验收需单独确认。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S01：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN、当前工作区差异，以及 workflow validator、
watcher、completion gate、scheduled runner、Git history guard 和相关测试。保护所有开工前用户改动，
运行 `npm run check:long-files`。只辨认、验证并收口 S01 已列的在途安全修复；不得开始 S02 或后续
Slice，不实现自治模式、Session rotation、Roadmap 自动领取或新审批入口。修改任一
function/class/method 前先运行 GitNexus upstream impact，HIGH/CRITICAL 必须先报告。完成 validator、
watcher、completion gate、scheduled runner、Git history guard 聚焦测试；必须证明运行时故障允许普通
提交但暂停未校验 dispatch、真实文档错误 fail closed、同一坏 blob 隔离后不阻塞后续提交，并验证三类
结果的去重用户通知。再完成 TypeScript、相关 ESLint、
long-file guard、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后，只精确提交 S01 相关文件，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
