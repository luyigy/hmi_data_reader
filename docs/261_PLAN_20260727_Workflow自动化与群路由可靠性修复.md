---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: 224_PLAN_20260725_通用项目定时任务平台.md
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow 自动化与群路由可靠性修复

## 背景

workflow completion gate 当前在 Coding Agent 已结束后才校验新提交的 PLAN/HANDOVER。
校验失败只把错误作为最终失败返回，不能让 Agent 自动修正文档。目标仓库没有
`package.json` 时，watcher Prompt 中固定的 `npm run workflow:validate` 还会诱导 Agent
创建无关脚本、搜索其他仓库并反复 amend。

真实失败还暴露了合同漂移：合同未要求 phase PLAN 包含 `roadmap`，但 HANDOVER 校验会
无条件解析所属 PLAN 的 `roadmap`，产生 `document reference is empty` 误报。

## S01：完成校验与 Agent 修订闭环

### 目标

让 workflow validator 成为自动执行链路的一部分：文档不合规时，平台自动把结构化错误
交回同一个 Coding Agent 修订、提交并重新校验；只有校验通过后才完成 TaskRun 并允许
watcher 推进。

### 实现边界

1. 修改相关共享 symbol 前，按仓库规则运行 GitNexus upstream impact；HIGH/CRITICAL 风险
   先报告。追踪 `assertWorkflowCompletion`、本地 harness 执行和 session continuation 的
   真实调用链，不修改普通非 workflow TaskRun。
2. 修正 validator 与合同不一致：
   - PLAN 没有 `roadmap` 且合同未要求时，HANDOVER 校验不得报空引用。
   - PLAN 有 `roadmap` 时，继续校验目标存在并要求可执行 Prompt 引用它。
   - 保留“下一 Session Prompt 必须引用当前 HANDOVER、所属 PLAN 和下一 Slice”的门禁。
3. 去掉 watcher Prompt 中对目标仓库 `npm run workflow:validate` 的固定假设。复用平台已有
   completion gate 作为权威校验入口；不得要求目标仓库新增 `package.json`、依赖或复制
   validator。
4. completion gate 失败时，只对 workflow 文档校验错误启动自动纠错：
   - 将失败文档、目标 HEAD 和逐项结构化错误投递回刚才的 Coding Agent。
   - 要求 Agent 只修订相关 PLAN/HANDOVER、提交后停止，不执行下一 Slice。
   - 复用原 TaskRun 开始时的 baseline 检查新提交，不能在重试时把无效提交当成新 baseline。
   - 复用现有本地 harness continuation/session 能力；不新增队列、状态机或数据库表。
5. 最多自动纠错两次。对规范化错误内容生成指纹；连续两次错误指纹不变时立即熔断并保留
   明确失败，不再启动 Agent，避免无法停止的循环。
6. Agent session 无法续接、修订后仍有未提交 workflow 文档、Git 历史被重写或出现非
   validator 错误时保持失败，不静默放行。

### 回归验证

至少覆盖以下真实流程：

- phase PLAN 无 `roadmap` 时，其有效 HANDOVER 可以通过校验。
- HANDOVER Prompt 缺少自身引用时，第一次 completion gate 失败会把错误自动交回同一
  Agent；Agent 修订并提交后第二次校验通过。
- 目标仓库没有 `package.json`，Agent 不创建 package 文件也能完成闭环。
- 自动纠错始终使用原始 baseline；仅重试而没有产生有效修订时不能通过。
- 相同错误连续出现时按上限熔断，且不会继续 spawn Agent。
- 普通飞书对话和非 workflow TaskRun 不启用自动纠错。

运行聚焦测试、TypeScript、相关 ESLint、`git diff --check` 和 GitNexus
`detect_changes`。不得重启服务，不得修改 `workflow-test` 的历史测试提交。完成后创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER，Prompt 只允许
执行 S02；提交后停止。

## S02：隔离群绑定、出站路由与工作目录语义

### 已确认问题

- HMI-Reader 与 Agent-swarm 两个飞书群绑定到同一个 LiveRoom。
- 入站按 `chatId` 找 binding，出站却只按 `liveRoomId LIMIT 1` 取任意 binding，导致回复
  串到另一个群。
- `LiveRoom.workingDirectory` 为空时回退到服务 `process.cwd()` 并同步给源任务。
- `/ap workspace` 实际主要展示 workdir 与授权根目录，命名和 `/ap room` 输出容易让用户
  误以为每个群拥有独立 workspace。

### 修复要求

1. 修改前对 LiveRoom binding 入站、出站和任务 workdir 解析相关 symbol 运行 upstream
   impact，明确所有消息出口。
2. 出站回复必须携带并使用本次入站来源的 binding/chatId；不得再按 `liveRoomId LIMIT 1`
   猜测目标群。一个 room 存在多个 binding 时也必须确定性回到原群。
3. 明确群绑定与 room 的隔离约束：优先阻止两个不同群静默绑定到同一普通 LiveRoom；若
   产品确实支持共享 room，则所有消息和状态必须保存来源 binding，不能依赖 room 反查。
4. `/ap workspace` 与 `/ap room` 至少应明确展示 room、绑定群、授权根目录和实际 workdir，
   不在本 Slice 发明新的 workspace 实体或迁移现有数据模型。
5. 覆盖双群绑定回归测试：两个群分别发消息，所有 Agent 回复、状态通知和错误回执都返回
   原群；workdir 查询不能暗示其为群独占。
6. 完成后创建 S02 HANDOVER，`next_action: next_slice`，Prompt 只允许执行 S03；提交后停止。

## S03：收紧 Antigravity 有效完成判定

### 已确认问题

Antigravity CLI 可能只把输入 Prompt 原样回显到 stdout 后以退出码 0 结束；当前适配器仅按
退出码判断成功，stdout 为空时还会合成 `Antigravity completed`，造成“什么都没做但成功”。

### 修复要求

1. 追踪 Antigravity executor、输出解析、工具事件和 participant/run 状态收口路径并运行
   upstream impact。
2. 成功至少需要有效最终输出，且不得只是规范化后的 Prompt 回显。删除空输出时伪造成功
   文案的行为。
3. 不把“必须修改文件”作为通用成功条件，因为解释、调查等任务可以合法零改动；工具调用
   只能作为辅助证据，不能替代有效回答。
4. 回显、空输出或无法解析的完成结果应进入明确失败状态，并保留诊断摘要，不得触发成功
   completion 或下游 workflow 推进。
5. 增加回显、空输出、正常文本回答和合法零文件修改四类聚焦测试。
6. 完成后创建 S03 HANDOVER，`next_action: next_slice`，Prompt 只允许执行 S04；提交后停止。

## S04：阻止命令与系统消息泄露凭证

### 已确认问题

历史 LiveRoom 系统消息曾持久化并展示包含数据库凭证的完整命令。相关凭证应视为已暴露；
凭证轮换属于外部破坏性变更，必须由用户或管理员执行。

### 修复要求

1. 追踪命令、环境变量、stderr/stdout、工具事件和系统消息进入数据库及飞书展示的所有入口，
   对共享持久化与消息发布 symbol 运行 upstream impact。
2. 在最小公共入口复用或增加统一脱敏，覆盖常见 URL 凭证、连接字符串、token/password/
   secret 环境变量；原始敏感值不得进入数据库、日志、飞书消息或测试快照。
3. 不记录真实凭证，不把历史泄漏内容复制到文档或测试。测试只使用明显虚假的占位凭证。
4. 评估历史数据清理范围，但未经用户明确授权不得删除或改写数据库历史消息。
5. 终态 HANDOVER 必须列出需用户执行的凭证轮换与历史数据处置步骤，以及服务重启后的四个
   Slice 真人验收清单；`next_action: await_acceptance`。

## 验收标准

- validator 错误会自动驱动 Coding Agent 修订，而不是直接结束为失败。
- 014 场景中的可选 `roadmap` 不再误报，缺少当前 HANDOVER 引用仍会被修正。
- 无 `package.json` 的目标仓库不需要任何验证脚手架。
- 自动纠错有明确次数上限和错误不变熔断，不会形成死循环。
- watcher 只在最终 HEAD 校验通过后处理下一个 Slice。
- 双群绑定场景的所有出站消息确定性返回原始入站群，不再使用任意 binding。
- workspace、授权根目录和实际 workdir 的展示语义清楚，不宣称群拥有不存在的独立空间。
- Antigravity 的 Prompt 回显和空输出不能被判定成功，合法文本回答不要求文件改动。
- 新产生的系统消息、命令与工具事件不会持久化或展示凭证；历史处置和轮换由用户授权执行。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/261_PLAN_20260727_Workflow自动化与群路由可靠性修复.md`、
`docs/224_PLAN_20260725_通用项目定时任务平台.md` 和
`docs/workflow/workflow-contract.yaml`，执行 S01。先追踪 workflow completion gate、
validator 与本地 harness continuation 的完整调用链，并对将修改的 symbol 运行 GitNexus
upstream impact。修正可选 roadmap 误报，移除目标仓库必须存在
`npm run workflow:validate` 的假设，并让 workflow completion 校验失败自动回投给同一个
Coding Agent 修订和提交后重新校验。所有尝试必须复用原始 baseline；最多自动纠错两次，
连续错误指纹不变立即熔断。不得影响普通非 workflow TaskRun，不得新增数据库表或目标仓库
脚手架。完成聚焦测试、TypeScript、相关 ESLint、`git diff --check` 和 GitNexus
`detect_changes` 后提交，并创建 `plan_progress: in_progress`、
`next_action: next_slice` 的 S01 HANDOVER；其 Prompt 只允许执行 S02 的群绑定、出站路由
与 workdir 语义修复。提交后立即停止，不执行 S02、S03 或 S04；不要重启服务或修改
workflow-test。
<!-- WORKFLOW_PROMPT_END -->
