---
doc_type: REPORT
doc_status: completed
---

# Ticket Agent 自主性：第一阶段只读诊断

依据 [512 提案](512_PROPOSAL_20261020_TicketAgentAutonomy.md)。源码基线为 `8b8970a3d5757abe8b44fcbdb3f1ef528d02ab24`。这轮未修改业务代码、运行账本、审批快照或宿主授权，未恢复生产 Ticket、重启或部署服务。只读查询、临时 Bubblewrap 文件读取探针和本文是本轮产物。

## 1. 当前真实阻塞

查询原 HMI 路线 `cmvdmf87w043f9xhgf9yvua6p`，当时 24 个节点中 10 个 passed、7 个 attention、7 个 planned。7 个暂停节点为 M05 与 R6_BOLE、R6_ARBURG、R6_DEMAG、R6_NISSEI、R6_FANUC、R6_YIZUMI。它们当前均报告 poteto-mode 必需技能不可读，`platformAttempts = 0`、`repairAttempts = 0`，不是预算耗尽。[账本摘录](../evidence/ticket-agent-autonomy/status-evidence.json)。

冻结任务描述明确要求读取 poteto-mode、Codex 映射及 `check-playbooks.mjs`，并要求必需技能不可用时阻塞。Agent 服从了这项要求。不能再增加“可选技能失败不得暂停”的提示来覆盖该明确合同，也不能把这些节点解释为用户还没有决定业务规则。

R6_YIZUMI 另报告资料源查询错误 1254018，本轮未追查该查询的完整链路。修好技能可见性不代表全部业务验收或资料问题已经消失。另一路线 S06 的 scope_change 也不能计入这 7 项环境失败。

### 环境根因及可重复观察

宿主 `/home/hello/.codex/skills/poteto-mode` 是有效链接，目标位于 `/home/hello/.local/share/pstack-claude/plugins/pstack/skills/poteto-mode`。

实际链路：

1. [`prepareGraphHarnessRuntime`](../../src/lib/task-graph/harness-runtime.ts) 将 skills 目录列为共享只读配置，但未登记目录内各技能链接依赖的实际资源集合。
2. [`codexReadOnlyPaths`](../../src/lib/harness/adapters/codex.ts) 传递显式只读清单。
3. [`wrapWithBubblewrap`](../../src/lib/harness/bubblewrap.ts) 的严格项目能力模式只挂载清单内路径，不自动扩展目录中的链接目标。该行为保护了业务资料的授权边界。
4. skills 目录可见，目录内 poteto-mode 链接目标不可见，Agent 因而读不到必需技能。

用真实 Bubblewrap、最小环境和临时空工作区执行读取探针：宿主技能可读；严格挂载只含 skills 目录时不可读；额外明确挂载该技能实际目录后可读。两种沙箱中宿主 `.env` 均不可见。[探针结果](../evidence/ticket-agent-autonomy/skill-probe.json)。探针不调用 Codex，不改生产运行目录，也没有修补线上挂载。

这证明了资源装配断层。探针只检查技能正文，尚未证明映射、脚本、相对引用与包依赖全部可运行。后续预检必须覆盖完整所需技能包，不能把“SKILL.md 存在”当环境准备完成。

## 2. 当前执行与会话架构

| 路径 | 当前调用链与行为 |
| --- | --- |
| 首次实施及重领 | `runTaskGraphCycle → claimNode → executeJob → implementationConversation → executeAcpxTaskRun(graphExecution)`，在原 job worktree 实施，由平台提交候选 |
| 实施中消息 | `receiveGraphRoomMessage/receiveGraphTaskMessage → conversation_input → deliverConversationSteering → Harness turn/steer`，已有能力把输入交给当前 Coding Session |
| 正常等待 | `waiting_for_user/answered → reconcileConversationWaits → ready → executeJob`，沿用候选与原 native session，不扣失败预算 |
| 材料或其他故障暂停 | `blocked → pauseGraphImplementation → waiting_decision`；missing_capability 归平台准备，不进行原样无限重试 |
| 暂停后的普通聊天 | `startConversationFollowups → conversationWorkspace → graphConversation`，在固定候选派生目录运行只读 turn |
| 只读聊天后继续 | Agent 输出 `TASK_GRAPH_CONVERSATION`，平台解析材料引用、权限与版本后，经 `handoffConversationMaterials` 交回实施 |
| 正式交付 | `parseImplementationResult(delivered) → sealConversationTurn → 集成/检查/独立复核与验收`，按批准模式决定是否解锁后继 |

关键源码：[`coordinator.ts`](../../src/lib/task-graph/coordinator.ts)、[`conversation-inbox.ts`](../../src/lib/task-graph/conversation-inbox.ts)、[`conversation-followup.ts`](../../src/lib/task-graph/conversation-followup.ts)、[`conversation-session.ts`](../../src/lib/task-graph/conversation-session.ts)、[`acpx/runner.ts`](../../src/lib/acpx/runner.ts)。

### 自主性受限的位置

- `reserveConversationFollowup` 排除 claimed、ready 和正常 waiting_for_user，其余暂停进入另一条只读路径。`executeAcpxTaskRun` 进一步硬性要求 graphConversation 只读。因此只删一句 Prompt 也不能让该 turn 获得实施写权限。
- 原 Session 的连续性已有 `conversationOwnerRunId` 和 native session 标识，问题不是每次都必须创建新 Agent；平台在同一会话外面切换了工作目录、权限和恢复协议。
- 普通等待可以由 Inbox 接回实施，材料等待却要求另一次模型控制输出与交接。用户在同一 Topic 内承担了两种路径差异。
- `prompts.ts` 同时规定流程选型、环境约束、多个结束标记和暂停分类；`conversation-followup.ts` 又要求模型理解内部状态与专用恢复行。最近 `8b8970a` 的历史材料修复有效，但继续维护这套协议仍容易产生新分支。
- `answered` 与 `waiting_for_user` 都变成正常等待；无结构化结论则可能进入 invalid_result 补收。必须把正常问答结束与真正提交成果分开，不能让普通一句回答触发交付或失败预算。
- 普通文字目前不在 `conversation-intent.ts` 中做关键词恢复分类。这一删除应保留，不能回到“看到继续两个字就拦截聊天”的实现。

现有事务锁、TaskRun 绑定、claim/revision、候选固定、Writer 退出证明和原生 Steering 都可以复用，不需要第二个调度器。

## 3. 应保留与应收回的职责

平台必须强制：批准的 Ticket 范围、调用者身份、资源授权交集、单 Writer、退出证明、claim/revision、幂等输入、预算、固定提交复核、真实验收和后继依赖。

Coding Agent 应负责：在可用且已授权的工程环境中调查、编码、测试、修复、使用资料、解释判断和吸收用户纠正。缺陷尚未修好或测试入口尚未编写，本身就是当前 Ticket 的工程工作，不能自动升级成平台或用户审批。

技能安装和资源可见性属于平台运行准备；仓内声明不能自行扩大宿主权限。受限工具确实不可用时不能要求 Agent 越过沙箱“自己修好”。

## 4. 推荐一个最小纵向 Slice

验收目标：一个已批准的测试 Ticket，从可用环境启动，在原 Topic 接受问题、资料和纠正，沿同一个实施入口继续，正式交付后由既有平台检查并放行一个后继。

### 运行准备先于模型派发

扩展现有 `prepareGraphHarnessRuntime` 的资源解析结果，登记宿主可信安装的技能包及其实际依赖路径和版本身份，作为只读清单交给现有 Bubblewrap。对本次声明需要的正文、工具映射和脚本进行同沙箱预检。实现可放在该函数内部或一个小型私有解析函数，不新增环境调度器。

不要关闭 strict 模式，不递归放行任意业务目录链接，不挂载整个宿主 HOME，不由仓内文件给自己授予宿主权限。完整技能包内容可只读共享，不需要复制全部项目图片。所需能力缺失时在平台准备阶段报告可执行修复项，不先派发模型再让它逐票重复发现。

### 未交付工作只走原实施入口

- 所有 Topic 输入仍进入同一个持久 Inbox。Writer 活跃时复用现有 Steering；退出已证实后，由原 Coordinator 领取下一 turn。
- 在原批准范围内、原工作区尚归当前 execution 的正常等待与材料澄清，由平台检查身份、阶段、候选、预算和退出证明，沿 `executeJob/implementationConversation` 接回原工作区。材料是否足够、判断是否需要修正，由原 Coding Agent 继续调查。
- 不再先开固定候选的只读答疑，再要求模型产生 `resume_implementation` 来获得实施权。已交付、独立复核中及待处理合流现场仍保持只读或既有专用修复路径。
- 真正越权、无法证明退出、耗尽预算和缺失必需运行能力继续拒绝重领。扩大范围与放宽验收不因普通消息而获得批准。
- 普通 turn 结束保存成果和回答，不提交交付；仅明确的正式成果提交进入平台检查。沿用原交付合同，不增加新的全局控制协议。保留旧控制记录的解释能力，迁移未完成记录后再删旧消费者。

Prompt 在本片中做减法：删除内部 claim/revision、只读答疑接力和恢复控制说明；只保留 Ticket 目标、可用工具、必要协作说明与正式提交成果的方式。不以提示词条款补偿路由或资源装配错误。

### 预计触及的文件与接口

| 位置 | 最小职责变化 |
| --- | --- |
| `harness-runtime.ts`，必要时一个私有资源解析函数 | 输出经宿主授权且身份固定的完整只读技能资源清单；启动前验证 |
| `conversation-inbox.ts` | 将可安全继续的未交付消息交给原实施路径；保留输入与 Writer 幂等 |
| `coordinator.ts` | 统一消费实施 turn，不另建 Topic 调度循环 |
| `conversation-followup.ts` | 限定为已交付或受保护阶段的只读对话；移除材料等待对第二轮控制行的依赖 |
| `implementation-result.ts` / `execution-progress.ts` | 复用既有正常等待、明确阻塞与正式交付语义，避免普通回答误算失败或交付 |
| `prompts.ts` | 删除流程接力条款，不增加新的“必须先判断”规则 |
| `acpx/runner.ts` | 优先保留现有 graphExecution/graphReview 权威校验；如需改调用方绑定，使用现有类型，不新开越权入口 |

Bubblewrap 的严格授权规则原则上不改；资源列表应由上游准备正确。无需修改 Prisma Schema、全局角色、Issue 协议或批准快照。

## 5. 可失败的验收设计

下表是下一阶段测试设计，本轮未实施或声称通过。

| 场景 | 必须观察的结果 |
| --- | --- |
| 必需技能为目录内链接 | 同一严格沙箱可读完整所需包并运行校验；未授权链接和宿主私有目录仍不可读；缺失时模型尚未启动 |
| 编码中询问进度、提供图片 | 进入当前 native turn，普通答复不封口、不提前交付、不新增可写 Writer |
| 问题后正常等待，随后补图或纠正 | 原 Session、原 job worktree 接续；不派只读中转 turn，不生成 resume_implementation 控制行，不重复发图 |
| 先前材料已被消费 | 后续 turn 可以引用该 execution 的历史材料；不能引用其他 execution 获得权限 |
| 范围内测试暴露缺陷、行为入口待实现 | 原实施者继续完成工程工作；平台不把它当作缺业务材料或新的人工审批 |
| Writer 活跃或归属未知 | 不抢占、不以固定延迟猜测退出；收到新消息也不能并发创建可写执行者 |
| 消息重送、进程在领取或交接后退出 | 持久 Inbox 与 claim 只消费一次；恢复意图不依赖内存 Promise；重启可继续或给出具体不可接管证据 |
| 普通回答与正式交付 | 前者不解锁后继、不消耗失败预算；后者通过原检查、批准模式的复核/验收后才解锁后继 |
| 真正范围扩大、额外资源和预算耗尽 | 平台仍拒绝，普通“继续”不能绕过 |

先用真实 Coordinator、PostgreSQL、Git、Bubblewrap 与可控 Harness 回归证明状态转换。再用经过飞书路线卡批准的隔离测试 Ticket 和真实 Codex/Topic 完成上述纵向验收，不拿模型替身冒充真实交互验证。已有 P0 事务、Review 接续、uncertain steering、会话历史材料和只读成果保护回归作为防退化门禁。

## 6. 为什么这个范围能减少补丁

修复资源装配发生在所有任务共用的运行入口，不给七个节点逐项加例外。未交付 Ticket 的下一轮工作由原实施入口承担，减少而非新增材料握手分支。已有交付、权限与 Writer 校验留在代码执行点，Agent 不再负责理解并驱动平台内部接力。

本轮按 512 第一阶段到此停止。实施上述一个 Slice 需用户确认；未自动开展 Gardening、Architect Inspector 或全仓文件重构。
