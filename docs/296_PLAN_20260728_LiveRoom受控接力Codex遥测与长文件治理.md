---
doc_type: PLAN
doc_status: completed
next_action: none
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Live Room 受控接力、Codex 遥测与长文件治理

## 背景与目标

本 PLAN 将以下三类已确认问题转为分阶段、可验收的实现工作：

1. `docs/290_ISSUE_20260728_AgentMention受控异步接力.md`：恢复普通 Live Room 中 `$member`
   的受控异步 handoff，同时消除同步递归、重复调度和成员锁悬挂；`@member` 继续只展示。
2. `docs/291_REPORT_20260728_Codex真实上下文与官方配额评估.md`：在不降低 workspace/network
   隔离、不泄露账户信息的前提下，为 Codex 接入官方 token usage，并把账户 quota 限制在管理员诊断边界。
3. 修复长文件口径并治理审阅基线 `067ccd878b0aeaf74d5af624e04e40ce85c5d5ff` 上 6 个历史超限业务源码，
   避免继续把职责堆入少数入口。

重复编号的 `docs/290_HANDOVER_20260728_Workflow权限策略S01交接.md` 属于已完成 PLAN 288 的历史交接，
不在本 PLAN 中重跑。新 PLAN 使用当前最高编号之后的唯一编号 296。

## 已确认事实

- 合同阈值为 800 行预警、1000 行阻断；`.next`、`node_modules`、`dist`、`build` 等生成物和依赖应忽略。
- 任务 Prompt 中 300 多个长文件包含生成物和依赖，是运行上下文扫描没有复用合同忽略规则；飞书
  “命中 3 个文件”表示相对 cursor 发生变化的超限文件，不是仓库当前总量。
- 当前 HEAD 的真实历史超限业务源码为：
  - `src/app/tasks/[id]/chat/page.tsx`：2455 行；
  - `src/components/live-room/LiveRoomWorkspace.tsx`：2188 行；
  - `src/lib/acpx/runner.ts`：1795 行；
  - `src/lib/live-room-delivery.ts`：1678 行；
  - `src/lib/live-room.ts`：1678 行；
  - `src/lib/feishu.ts`：1454 行。
- GitNexus 已确认 `triggerLiveRoomMessageReplies` 为 CRITICAL：4 个直接依赖、7 条流程，覆盖 Web、
  飞书、长连接、绑定房间和 Workflow。结构拆分与 handoff 行为修改必须分开提交。
- GitNexus 已确认 `runCodexAppServer` 为 HIGH：2 个直接依赖、3 条流程，覆盖 Codex adapter、真实
  Agent 和任务执行。隔离未验收前不得替换普通 JSON 默认路径。

## 产品与架构决策

- 普通 Live Room 中，`$member` 请求一次 handoff；`@member` 永远只作可见引用。
- 一条 assistant 回复最多一个目标。多目标、未知目标或不允许 handoff 的流程只记录明确提示，不调度。
- `handoff` 的计数单位是一次被持久化原子 claim 接受、并为下一成员创建 delivery 的接力边；初始
  用户消息触发首位 Agent 不计数。A→B 消耗 1 次，B→A 再消耗 1 次；同一 delivery 的恢复或重试、
  重复 watcher 事件以及被拒绝的未知/多目标请求不重复计数。claim 已接受但目标随后离线、停止或失败，
  仍消耗该次预算，避免失败重试绕过上限。
- 新建 Live Room 的 `handoffLimit` 默认值为 4，表示同一根消息在首位 Agent 之后最多再调度 4 次，
  即整条链最多执行“首位 Agent + 4 次后续 Agent”；4 是保守默认值，不是散落在调度代码中的硬编码。
  该默认值足以覆盖 A→B→A，并给继续转交或返回发起者保留余量，同时限制错误循环的成本。
- `handoffLimit` 以 Live Room 持久化设置为唯一运行时规则源；`/ap room --handoff-limit=<N>` 在建房时
  设置，`/ap handoff-limit <N>` 查询或修改当前房间，`N=0` 表示关闭自动 handoff。S07 必须复用现有
  房间管理权限，拒绝负数、非整数和超出实现所声明安全范围的值，并用系统消息记录变更。Web 与飞书读取
  同一字段，不各自维护默认值。
- `docs/workflow/workflow-contract.yaml` 继续只作为 PLAN/HANDOVER 自动化合同，不存放 Live Room 产品
  运行参数；本 PLAN 不新增第二个 YAML 配置源。若未来需要平台级统一默认值，再单独立项定义配置优先级，
  不与本次房间级设置混用。
- `/ap plan`、PLAN revision、`/run` 及其他未显式允许 handoff 的结构化 Workflow 保持既定编排，
  输出中的 `$member` 只展示。
- 当前 delivery、TaskRun/participant 必须先进入终态并释放成员执行锁，提交成功后，后续 delivery 才
  进入可领取状态；B 的开始时间必须晚于 A 的终态提交和锁释放。调用栈不等待后续成员。
- A→B→A 允许 A 在前一次执行锁已释放后重新领取新 delivery；每一跳都是独立持久化调度，不持有上一跳
  的锁或调用栈，因此回到 A 不构成循环死锁。是否继续只由剩余 `handoffLimit`、成员状态和停止状态决定。
- 复用现有 Live Room message、delivery、成员队列、TaskRun 和 Session continuation。只增加满足
  assistant reply 幂等 claim 所需的最小持久化约束，不新增第二套工作流引擎或通用状态机。
- 停止、离线、超时、重启恢复失败、预算耗尽和超限都必须收敛到现有明确终态、释放锁并发送系统消息；
  不静默丢失，不猜测创建新 Session。
- Codex provider token usage 写入 participant 既有 `controlMetadata`，带采集时间和来源；无官方值时
  继续使用现有 `estimated` 水位。
- account quota 属于认证账户，不属于普通 Room 成员。普通房间 payload 不携带 quota；首版仅允许管理员
  诊断入口按账户边界查看使用百分比和 reset 时间，不保存凭证或原始认证数据。
- 每个结构治理 Slice 只搬移职责并保持公开出口、调用签名和行为；功能变化只能进入后续独立 Slice。

## 范围

### 包含

- 长文件 runtime baseline 与飞书通知口径的单一规则源修复。
- 6 个历史超限业务源码的 feature-based 职责拆分。
- 普通 Live Room `$member` 受控异步 handoff、幂等、轮次预算、终止和可观察性。
- 房间级 `handoffLimit` 持久化设置及其 `/ap room --handoff-limit`、`/ap handoff-limit` 管理入口。
- `platform_local` Codex App Server 隔离等价性、token usage 采集、metadata 持久化和现有水位展示。
- 管理员限定的账户 quota 诊断能力。
- Web 与飞书 Live Room 的一致行为和聚焦回归覆盖。

### 不包含

- 不恢复 `$member`/`@member` 的旧同步递归语义。
- 不让自由 mention 改写 PLAN、revision、`/run` 或其他结构化 Workflow 顺序。
- 不新增通用工作流引擎、账户用量历史报表、多厂商 telemetry 抽象或与 `handoffLimit` 无关的 Prisma
  迁移。
- 不把普通 Codex 执行直接、无回退地全量切换到 App Server。
- 不扩大 workspace、Session、Room 或账户权限，不把 quota 广播给普通成员。
- 不在纯拆分 Slice 中顺手修业务行为，不重启服务，不操作生产数据。

## 执行顺序

### S00：统一长文件扫描与通知口径

让 runtime baseline 直接复用 `workflow-contract.yaml.large_files` 的阈值、扩展名和忽略路径，删除或绕开
重复规则。飞书通知同时显示“本次变化数”和“当前业务源码总数”，带精确 Git SHA，并明确增量与总量。

完成标准：

- Prompt 不再列出 `.next`、`node_modules`、构建产物、迁移或 vendor；
- 在审阅基线 `067ccd878b0aeaf74d5af624e04e40ce85c5d5ff` 等价输入下，当前超限业务源码总数为 6；
- 新增达到阻断线或历史超限继续增长仍被拦截；
- 不改变 workflow completion gate 的状态转换。

### S01：纯拆分 Task Chat 页面

从 `src/app/tasks/[id]/chat/page.tsx` 按现有 feature 责任提取 timeline/message rendering、composer 与控制、
权限编辑、run history/participant inspector、类型和纯派生函数。页面入口只保留数据编排与布局。

完成标准：原文件和新增文件均低于 800 行；请求、Socket、审批、权限、执行、续接和交互语义不变。

### S02：纯拆分 Live Room Workspace

从 `LiveRoomWorkspace.tsx` 提取成员/运行状态面板、消息时间线、composer/mention、房间控制和纯展示模型；
Workspace 仅组合现有 hooks、状态和布局，不改变 payload、轮询、Socket 或权限行为。

完成标准：原文件和新增文件均低于 800 行；Web Live Room 可见性、发送、停止、审批和水位展示不变。

### S03：纯拆分 Live Room delivery

保留 `live-room-delivery.ts` 薄 facade 和现有公开出口，提取目标选择与路由、ACPX 执行与 continuation、
claim/retry/过期、成员队列和终态收敛。不得在本 Slice 加入 290 handoff。

完成标准：原文件和新增文件均低于 800 行；Web、飞书、长连接、绑定房间和 Workflow 调用签名不变；
既有 delivery 并发、停止、超时和重试回归通过。

### S04：纯拆分 Feishu 命令入口

复用已存在的 `feishu-*` 模块，继续按命令域提取 status/gateway/agent/host、Live Room 成员与模式、
task/chat/grant/rights/approval/workspace；`handleFeishuCommand` 仅保留薄路由和兼容出口。

完成标准：`feishu.ts` 和新增文件均低于 800 行；Webhook 与长连接共用原路由，解析、权限检查、审批和
回复行为不变，权限检查不被移动到不安全边界。

### S05：纯拆分 ACPX runner

从 `src/lib/acpx/runner.ts` 提取 harness 执行生命周期、participant/TaskRun metadata 持久化、
continuation/恢复、终止与错误归一化等现有职责；保留当前公共入口和事务边界，不加入 telemetry。

完成标准：原文件和新增文件均低于 800 行；Codex/Claude/其他既有 Harness 的新运行、续跑、停止、
权限和结果持久化语义不变。

### S06：纯拆分 Live Room 服务

从 `src/lib/live-room.ts` 提取消息/成员序列化、水位派生、权限与可见性、Room/TaskRun 读取模型；
保留现有公开 API 和 payload，不加入 provider telemetry 字段。

完成标准：原文件和新增文件均低于 800 行；Web、飞书及 API 消费的现有 payload 和权限过滤不变。
至此 6 个历史超限源码全部低于 800 行。

### S07：实现 290 受控异步 handoff

在 S03 的明确边界上解析 assistant reply 的单个 `$member` 意图，以 assistant reply 身份和根消息预算做
持久化幂等 claim。为 Live Room 增加最小的 `handoffLimit` 持久化设置：新房默认 4，既有房迁移后也为
4；运行时只读取房间设置。复用 `/ap room` 参数解析与现有房间管理权限，提供
`/ap room --handoff-limit=<N>` 和 `/ap handoff-limit <N>` 查询/修改入口，`0` 关闭自动 handoff。
当前 delivery、TaskRun/participant 先终态并释放锁，事务提交后下一 delivery 才可领取；复用原 Session
continuation 和权限快照。`@member`、多目标、未知成员、结构化 Workflow、超限和所有终止原因按已定
产品语义处理。

完成标准：

- A→B 中 B 的开始时间严格晚于 A 的终态提交和锁释放；A→B→A 中第二次 A 使用新 delivery，在没有
  上一跳锁或嵌套调用栈的情况下运行；
- 默认 `handoffLimit=4` 时，同一根消息最多产生 4 条已接受 handoff 边；调整房间设置后立即对新建根链
  生效，已有根链按“创建根链时固定的预算快照”继续，避免中途改值造成竞态；
- `/ap handoff-limit` 可查询、修改和用 `0` 关闭，非法值或无房间管理权限时不写入；网页、飞书和恢复
  路径使用同一持久化值，不读取 `workflow-contract.yaml` 或另一份 YAML；
- 并发 watcher、重复事件或恢复不能为同一 assistant reply 创建两个有效 handoff；
- stop、离线、超时、中断、重启恢复失败和预算耗尽均释放锁、落明确终态并发送系统消息；
- 网页与飞书行为一致，Session、workspace 和权限快照不扩大。

### S08：补齐 Codex App Server 隔离与生命周期等价性

先核对仓库锁定/当前安装版本的 `thread/tokenUsage/updated`、`account/rateLimits/read` 和
`account/rateLimits/updated` payload。让 App Server 复用已验收的 Bubblewrap、workspace realpath、
network 快照、隔离 `/tmp` 和公开只读例外；覆盖新 thread、resume、审批、超时、中断、PID 持久化和
Session continuation。保留 JSON 路径回退。

完成标准：隔离和生命周期验收通过前默认路径不切换；受限 workspace 继续拒绝不等价模式；失败可安全
回退 JSON 路径且不会重复执行 turn。

### S09：实现 291 provider telemetry 与管理员 quota

App Server 回调 token usage；Harness/ACPX 将最新值、采集时间和来源写入 participant
`controlMetadata`。Live Room 序列化优先使用新鲜 provider 值，缺失或过期时使用 `estimated`，Web/飞书
复用现有水位入口。账户 quota 只进入管理员诊断接口/命令，并按账户边界授权和缓存。

完成标准：

- 新 thread、resume 和审批路径都能更新 token usage，缺值/乱序/过期通知可安全降级；
- 普通 Room/API payload 不含 quota、账户标识、凭证或原始认证数据；
- 管理员只能看到获授权账户的 `usedPercent`、窗口和 reset 时间；
- JSON 回退和非 Codex 成员保持现有估算行为。

### S10：综合验证与终态交接

在不触碰生产数据的隔离环境完成 290/291 与全部长文件门禁回归。真实飞书消息和服务重启只有在用户另行
明确批准后才执行；未获批准时用已有单元/集成边界完成自动化验收并在 HANDOVER 明确记录未执行项。

完成标准：

- 6 个历史超限文件和所有新文件均低于 800 行；
- A→B、A→B→A、重复事件、stop/离线/超时/重启恢复失败、Web/飞书一致性通过；
- Codex App Server 隔离、thread/resume/审批/中断、provider/estimated 降级和 quota 权限通过；
- TypeScript、相关 ESLint、聚焦测试、long-file guard、`git diff --check` 和 GitNexus
  `detect_changes` 通过；
- 创建 `plan_progress: complete`、`next_action: none` 的终态 HANDOVER 后停止。

## 风险与控制

- **CRITICAL delivery 影响面：** S03 只做纯搬移并保留 facade；S07 才改变调度。两个 Slice 分开提交、
  分开验收，开始前分别重跑 symbol upstream impact。
- **HIGH App Server 影响面：** S08 保留 JSON 回退，不在隔离、resume、审批、中断和 PID 等价性完成前
  切默认路径；任何重复执行风险都按失败阻断处理。
- **并发与死锁：** handoff 使用数据库原子 claim 和现有 delivery 终态，不使用进程内 Promise 递归；
  所有退出路径必须先收敛状态和释放成员锁。下一 delivery 在上一跳终态事务提交前不可领取；返回曾执行
  成员时只领取新 delivery，不复用旧锁。
- **预算配置：** `handoffLimit` 是房间级产品设置，不进入 workflow contract；根链创建时保存预算快照，
  防止运行中改值改变既有链。修改命令复用房间管理权限并写系统审计消息，避免普通成员无限放大运行成本。
- **权限与隐私：** handoff 继承且不能扩大原 Session 权限；quota 不进入普通房间 payload，不持久化
  认证材料。真实外部写入和重启需再次授权。
- **结构回归：** 纯拆分 Slice 禁止混入行为变化；每个被修改 symbol 开工前执行 GitNexus upstream
  impact，HIGH/CRITICAL 先报告，提交前运行 `detect_changes`。
- **历史长文件：** 任一 Slice 都不得让 6 个历史文件增长；新源文件不得达到 800 行预警线。若提取边界
  无法在单 Slice 验证，应缩小职责，不把多个超限文件重新合并成新的大模块。
- **工作区保护：** 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动属于用户，不修改、
  清理或提交。

## 验证矩阵

| 领域 | 必须验证 |
| --- | --- |
| 长文件口径 | 忽略路径、增量/总量、精确 SHA、历史增长、新跨线、6 个源码总量 |
| 纯结构拆分 | 公共出口、类型检查、原聚焦测试、行数、GitNexus 预期流程 |
| Handoff | `$member`/`@member`、单/多/未知目标、A→B 严格时序、A→B→A 回环、边计数、默认 4、0 关闭、修改后新根链生效、重复 claim |
| 终止恢复 | stop、离线、超时、中断、重启恢复失败、预算耗尽、锁释放、系统消息 |
| Workflow 隔离 | `/ap plan`、revision、`/run` 不被自由 mention 改序，权限快照不扩大 |
| App Server | sandbox/network、thread/resume、审批、PID、超时/中断、JSON 回退 |
| Telemetry | provider 更新、乱序/过期/缺失降级、estimated 回退、Web/飞书展示 |
| Quota 安全 | 管理员授权、账户隔离、普通 payload 无 quota、无凭证持久化 |

每个实现 Slice 只报告实际运行的验证；失败必须保留证据，不得写成通过。真实飞书验收使用隔离测试房间，
且需要用户在对应 Slice 明确授权外部写入与必要的服务操作。

## 待确认项

以下事项不阻塞 S00，必须在对应 Slice 开始前确认：

1. S07 真实飞书联调所用的隔离测试房间、测试成员和允许发送消息的时间窗口。
2. S08 当前部署将固定使用的 Codex/App Server 版本及其实际 telemetry payload；若版本不支持，保持
   JSON 路径和 estimated 水位，不自行升级生产依赖。
3. S09 管理员 quota 诊断的最终入口选择命令或现有管理员诊断页；默认选复用现有管理员命令，避免新增页面。
4. S10 是否授权重启相关测试服务和执行真实飞书验收；未授权则记录为未执行，不阻塞自动化验证结果的事实交接。
