# 任务话题连接原执行者

## 目标与批准

用户于 2026-10-19 明确批准：任务话题直接连接负责该任务的执行者，支持边聊边做；平台保存进度、避免重复启动、按依赖自动接续并支持跨仓并行。任务内部的人机问答是正常执行，不以无人值守为前提。

## 用户行为

1. 用户在子任务原话题问进度、回答问题、补材料或纠正方向，均交给同一任务的执行会话。
2. 正在执行时可靠排队，具备原生 steering 能力时送给当前执行者；无此能力时在当前轮结束后交付，不用中断模拟发送。
3. 执行者等待回答或进程已退出时，新消息接回原会话与工作区，不要求说“继续”、复制图片或补发命令。
4. 只有任务真正交付且通过批准的检查与验收才释放后继。一次回答、TaskRun completed 或等待用户均不代表交付。
5. 独立任务继续并行；一个任务等用户不应占住其他任务的执行容量。
6. 已集成/已验收的交付可继续问答，但必须保护固定提交。后续修正需通过受控修复/范围调整，不能凭随口提问偷偷改已验收成果。

## 当前机制与替换边界

当前 `feishu-live-room` 在启动 Agent 前调用 `conversation-intent` 的正则。命中后直接恢复、不启动普通回复；未命中又被 `conversation-task` 改为只读 discussion 任务。`coordinator.executeJob` 的参与者没有接入原 session。当前 HTTP control 和退出后的 interaction continuation 还能绕过 graphExecution 直接开 run。

删除子任务的自然语言正则恢复入口与只读 discussion 分流。父任务仍是路线对话，不能把任意父消息派给猜出的子任务。兼容旧恢复事件，但新子任务消息只走持久 inbox，由协调器统一消费。显式菜单/API 控制必须走同一归属边界。

## 数据与职责

- `TaskGraphExecution` 是任务执行身份，TaskRun 是一次运行，不能混为一个生命周期。
- `ExecutionProgress` 持有当前阶段、claim/revision、候选、writer 与明确的等待输入状态。
- 入站原文/附件引用和来源身份持久化；用已有 `TaskGraphEvent` 的唯一幂等键去重。输入命令与消费回执可以是追加事件，不以历史事件推测当前执行阶段。
- 调度器唯一拥有实施 turn、等待状态、阶段推进与再调度。
- harness 理解自然语言，平台只验证身份、任务归属、执行权和状态合法性。
- 原会话绑定以原参与者的 native session 信息为准，复用 `getContinuationSession`、TaskSession 和获批 participant。原会话确实不可恢复时明确记录降级与上下文来源，不能悄悄变成另一只读机器人。

调用方应只需“接收任务消息”和“协调当前任务”，不协调多套恢复接口。具体 API 由实现拥有者结合现有事务边界确定，并同步到本文。

## 关键不变量

- 同一 Feishu messageId 只产生一个输入。断连重投不丢失、不重复启动。
- 活跃 TaskRun 的消息只有原执行者消费；其他进程不得抢占同一 worktree。
- 续接前验证 writer 已退出，unknown 不能当退出。claimToken/revision 拒绝旧结果。
- 先持久化派发身份再启动；崩溃后发现已有目标运行只观察，不启动第二个。
- 原生 steering 发送结果未知时保留 unknown 证据，不谎称 exactly-once 或盲目重放。
- 本轮正常回答/等输入有明确非交付结果；不会进入缺尾注补收循环，也不扣修复/环境预算。
- 当前轮返回结果后、进入检查/集成前，必须处理消息竞争，保证新输入不被悄悄遗留。
- 新消息本身不批准提权、扩大范围、重置耗尽预算或解除真实环境阻塞。保留原 blocker，并由执行者解释/处理输入。
- 所有 graph 子任务的启动入口，包括 HTTP control 和交互请求续接，都服从同一 writer/graphExecution 边界。
- 服务重启不能丢输入、丢会话身份或制造第二个执行者。

## 架构方案比较

A：复用 TaskRunControlMessage，为任务话题增加统一消费者。优点是已有字段和投递状态；缺点是 taskRunId 必填，输入被绑在某一次已结束运行，首轮/重试与任务级生命周期还需跨表协议。

B：以任务执行为目标的持久 inbox，协调器运行 turn，使用原 TaskRun/native session 能力。输入与幂等回执复用 TaskGraphEvent，不新建第二任务表。阶段与 writer 仍在 ExecutionProgress。

选择 B 为基础，吸收 A 的原生 steering、会话恢复与现存旁路检查。理由是用户消息属于任务，TaskRun 只是当前投递目标。拒绝直接调用通用 continue_session API 启动独立 run，这会绕开图的归属、候选与验收。

评审来源：独立设计读者 conversation_design_a 与 conversation_design_b，均认为调度器应拥有持久任务对话。GitNexus impact 因共享 LadybugDB 只读恢复错误不可用，影响范围通过真实调用方追踪；不能将查询失败当作低风险。

## 验收

必须通过真实 PostgreSQL/Git 与受控 harness 的集成场景，出站飞书可用明确替身：

- 真实投诉、问句、否定、普通补充都进入原任务 inbox，不产生正则恢复或只读 discussion 运行。
- 问题、回答与继续实施保持相同 execution/worktree/native session。
- 执行中消息可达或有明确排队状态，不启动第二 writer。
- 正常等用户不交付、不扣失败预算；回答后自动接回。
- 两个仓并行，一个问答等待期间另一个推进；完成验收后后继自动启动。
- 重复 webhook、并发消费者、启动边界崩溃、旧结果与 writer unknown 均保留一致性。
- 已集成/验收问答不改变候选和完成证据。
- 保留既有独立验收、预算耗尽、权限和所有权的安全门禁。

线上部署与业务续跑分开。本轮实现和验证期间不重启现有服务，不拿真实任务做破坏性故障注入。

## 实施契约

- `receiveGraphRoomMessage` 从已保存的用户消息取得原文、附件元数据和真实来源身份；`receiveGraphTaskMessage` 是已认证 HTTP/交互入口使用的任务消息边界。幂等键使用原始 Feishu messageId，重复 webhook 在发现旧房间消息后仍补做 enqueue。
- `conversation-inbox.ts` 保存输入、原生 steering 尝试、TaskRun 绑定、终态结果及投递收口。绑定表示已派发，不等于已处理。进程退出但无结果的输入转为明确的投递不确定上下文，让原会话先核查已执行动作；不能重发原生 unknown steering 或谎称 exactly-once。
- 协调器原有循环统一运行实施和话题后续轮次，共享四个执行容量。正常等回答不占执行槽。`waiting_for_user` 保存在 ExecutionProgress，`answered` 和真正提问用 waitingKind 区分，均不是交付或失败，不扣失败额度。模型仍应在回答状态问题后继续可执行的获批工作。
- `conversation-session.ts` 只从原实施者 lineage 读取 native session，复核 TaskRun 不成为对话所有者。完成后问答复用相同 native 会话，当前轮返回新的会话身份时后续继续使用新身份。没有可恢复身份时记录明确的降级事件与工作区、候选、原摘要来源。
- 每轮实施在节点锁内封口输入。封口前的新消息先进入下一实施轮；封口后进入的消息记录 receivedPhase=integrate/architecture/acceptance，排队到原阶段写入者结束后解释或提出受控修正，不改变已封口的交付。不能把封口后的随口消息当成修改验收成果的授权。
- 后续问答复用 ExecutionProgress.worker，并绑定 conversation reservation/TaskRun；复核和实施领取都检查该归属。固定成果使用单独的 pinned linked worktree，源码和 Git 元数据只读，复用原 claim 已固定的运行能力。不会为问答放宽 runtime 校验。
- 历史材料类暂停可以由原实施会话输出 `TASK_GRAPH_CONVERSATION {"action":"resume_implementation","inputIds":["具体材料消息id"],"note":"补齐材料与理由"}`。平台验证所引消息属于本轮，且整批输入均具有管理员/任务拥有者恢复权限、当前 revision、候选和 writer 退出，仅将目标 execution 交回实施。同节点的权限、范围、环境等兄弟阻塞保持不变，不重置预算。
- 子话题消息统一交给任务实施者。明确提及其他成员的原文及目标元数据保留在输入中，不隐去指向或伪装该成员已答复；独立架构/验收仍是原角色的独立阶段。新增实时多架构师协作不属于本次范围。
- HTTP 消息、继续与即时纠正动作都登记同一 inbox；是否能立即 steering 取决于当前 harness。交互输入回答同样入队，权限批准仍必须经原生批准流程，不把文本答复当成权限批准。所有通用 ACPX 启动都核验 graphExecution/graphConversation 归属，不能另开旁路写入者。
- 材料目录在首轮启动前固定挂载；后续话题图片由宿主读取已绑定父/子话题并写来源与 SHA-256 索引，排队轮次与原生 steering 都收到可实际读取的材料路径。飞书凭据不进入执行环境。
- 新版 reader 必须先具备解析 waiting_for_user/conversation 字段的能力，再启用产生这些状态的协调器。部署需要统一切换 API、Feishu relay 和协调器；本次实现不对线上服务做分模块热加载或业务恢复。

后续问答准备失败按原始 rootInputId 批次最多两次，至少15秒退避；重试衍生的新输入ID不会重置该额度。失败原因写入持久事件与原话题 outbox，单纯正常等用户不使用这些失败额度。ready 实施先领取，后续问答仅使用剩余执行容量。
