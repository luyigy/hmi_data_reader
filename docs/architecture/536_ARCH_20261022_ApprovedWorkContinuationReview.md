# 获批 Ticket 自然继续：修复计划评审稿

状态：评审定稿。pi-agent、kimi-code 与 Codex 已就下述通道拆分及原因保存契约达成共识；用户已取消 antigravity 评审。仅提交设计计划，尚未实施或验收。

源码基线：`db489e1`。设计参考为 527、528、529；行为以当前源码及实际回归为准。
本轮只写设计计划，不修改业务代码、生产账本、批准范围或预算，不部署、不恢复任务。
本文不是 Session 接力协议，不触发任务图派发。

## 1. 产品要求与修复边界

Task Graph 按批准路线调度，Coding Agent 负责工程实施，Verifier 负责独立验收。
Ticket 获批后，普通工程失败、进程退出、自然提问不撤销该范围内的工作资格。
用户正常回复应进入原 Agent Session，沿用原 Worktree 和当前候选。
独立 Ticket 并行，真实依赖在前置交付合格后释放。

这次主要改 Task Graph 的对话交接与执行放行边界。复用现有 Coordinator、admitNode、
applyExecutionOutcomeTx；不新增 Scheduler、Recovery Manager、持久状态字段或 wake source。
保留用户暂停、成本和资源配额、无进展控制、Sandbox、Project Capabilities、单 Writer、
claim/revision、Git CAS、W001、固定候选、独立验收及上游资格保护。

## 2. 已核实的缺陷与尚未证明的部分

| 当前事实 | 文件与位置 | 影响 |
| --- | --- | --- |
| 同一材料类别白名单存在两处 | conversation-followup.ts 的 resume_implementation 分支；preparation-recovery.ts 的 materials 分支 | 失败类别成为继续资格的代理，普通回复可能完成但实施没有接回 |
| materials 的 reservation、revision、输入身份不表达业务决定 | preparation-recovery.ts 的 admissionHold、admitNode | 直接删除白名单会允许未解决的人工决定进入执行；仅验证并发安全不足 |
| permission/scope/question 的 hold 当前只针对 conditions | preparation-recovery.ts 的 admissionHold | 不能把现有 hold 说成所有来源都具备的决策保护 |
| 登记阶段和当前阶段重复比较并抛错 | coordinator.ts 的 recoverTaskGraphNode | 旧请求可能因节点正常推进而要求用户再次继续 |
| 非 review 且非 conditions 的放行统一选择 implement | preparation-recovery.ts 的 admitted outcome 构造 | 不能声称所有来源已按当前 phase 原样接续；须明确阶段转换 |
| 恢复验收入口还承担互斥、幂等和实际启动 | coordinator.ts 的 recoverTaskGraphNodeVerification | 不能连同重复路由一起直接删除 |
| doctor 使用旧预算、恢复审批描述及项目业务词 | run-doctor.ts；prompts.ts；coordinator.ts | 诊断和提示可能与当前控制流、产品要求不一致 |

目前没有新增测试结果。既有测试不能作为阶段 mismatch 和稳态决策绕过已经覆盖的证明。
具体故障由尾调用同步依赖唯一导致等历史归因，尚未逐条证实，不作为实施前提。

## 3. 核心设计决定，供评审

### 3.1 区分继续已批准工作与执行待批准动作

分类保留作事实记录。删除两份材料类别白名单，不换成配置列表。
执行放行不能把消息作者合法等同于批准新资源，也不能把旧 permission_required
等同于整张 Ticket 永久不可工作。

| 情形 | 预期行为 |
| --- | --- |
| 新目录未授权，但现有资料和工作可继续 | 原 Agent 可继续原批准范围，新目录仍不可读 |
| 用户随口回复，没有解决待裁定的业务决定 | 允许对话；不得自动替用户选择并执行待决定动作 |
| 新输入已明确解决业务问题 | 由现有身份、输入和阶段边界核验后继续，不新增恢复审批 |
| 权限撤销或批准快照不再匹配 | 禁止受影响执行，不用聊天绕过 |
| 用户明确暂停路线 | 对应 taskGraphRun.status 的 run 级暂停；admitNode 沿现有拦截保存消息、不启动工作，不新增节点暂停门 |
| 测试失败、工具参数错误、缺资料 | Agent 调查、修复或检索已批准来源；不据类别撤销工作资格 |

不能只把白名单改成 permission/scope 黑名单，否则授权范围内的工作仍会卡住。
也不能只依赖模型承诺不越界。资源访问由现有 Capabilities/Sandbox 实际约束，
业务决定及阶段操作由现有批准输入、Stage Request 和验收边界约束。

#### B1：先保留结构化等待原因，再统一材料交接判断

源码核实：implement 的 waiting_for_user 默认 waitingKind 为 question，并非缺少 question。
但 waitingKind 不能承担决策权威：会话收尾可继承旧值，restart 接管可把材料等待标成 question。
implementation-result.ts 当前把 permission_required/scope_change 转成 waiting_for_user 时，
没有传递本次结构化原因，waiting_for_user outcome 也不写入该原因。
历史 lastFailure 即便残留，也不能自动认定为本次等待的可靠事实。

本稿选择复用已有 progress.lastFailure 保存本次等待原因，不新增 waitingCause、数据库列、
持久状态或 wake source。修改 implementation-result.ts 的 outcome 构造、execution-progress.ts
的 waiting_for_user outcome 类型、校验和写入，使 code、requiresUserDecision 和 detail
属于本次等待。普通提问需明确清理不再有效的旧原因，不能沿用过期 permission 标记。
waiting_for_user outcome 携带本次 failure 则保存，不携带则清理过期 lastFailure。
admitted 成功时清理当前等待原因及展示字段，历史事件保留；清理不得作为权限批准的替代。
资源授权、待执行动作与当前 Stage Request 的保护仍独立有效。
同样核对 conversation-inbox 的收尾和 restart 接管，保证它们不丢失原因、不用 waitingKind 改写原因。
这是现有 JSON 账本内容与内部 outcome 契约的修复，不是新增 Prisma schema 字段。

材料边界读取本次结构化 lastFailure.requiresUserDecision/code，不能单独使用 waitingKind。
waiting_decision 与 waiting_for_user 两种形状采用相同的事实语义。
reservation、revision 和输入授权仍分别验证身份、并发一致性和来源，不代替业务决定。
调用方的前后比对只作提前提示，导出的 handoff/admit 边界必须独立成立。

materials 不能把未解决的具体权限/范围/业务决定当作已经解决。
新增资源授权沿既有 project_capability_scope_approved 核验；该事件仅证明对应资源批准，
不能替代业务选项裁定，也不能仅凭时间较晚就放行不匹配的范围。
operator 与 conversation 的原有合法问答入口不新增此类类别门，但仍保留资源和阶段保护。
operator 消息身份合法同样不代表扩大资源范围。

必须同时保住两项行为：未解决决定不被模型材料交接绕过；用户正常回复可以接回原批准工作。
只读会话轮不获得写权限。可写实施轮由既有 operator、conversation 或合法 materials 放行产生，
仍核验 Writer 退出、reservation、revision、候选和当前 Stage Request，不增加旁路。
只读轮的正确保护在 conversation-followup.ts 与 review-permissions.ts，不能为了继续工作而放宽。

旧记录缺少可靠原因时，从同一 execution、同一等待轮次的既有 outcome/blocked 事件核对来源，
不把其他轮次事件套用，不批量改账本，不依据自然语言猜测授权。
implementation_blocked 是来源之一，但并非所有有 progress 的等待都会写该事件。
已知为普通提问的 outcome 与找不到可靠事件的 unknown 必须区分，不能仅凭 lastFailure 缺失判断。

不可还原原因时，规则按通道划分：

| 通道 | unknown 时的行为 | 仍保留的边界 |
| --- | --- | --- |
| 模型发起 materials 自我接续 | 拒绝自动交接，返回 unknown_wait_cause 等现有结果 reason，不新增状态 | reservation、revision、逐条输入授权、决定保护 |
| 经身份核验的用户显式 operator 继续 | 不因 unknown 单独拒绝，接回当前合法阶段 | run 暂停、Writer、候选、批准范围、资源和验收保护 |
| 合法用户新回复的 conversation wake | 不因 unknown 单独拒绝，可接回原 Session 的可写实施轮，不要求再发送恢复命令 | 逐条输入授权、原任务归属及全部执行边界 |
| conversation-followup 只读问答轮 | 保持只读，可以查已授权资料、回答和澄清 | 原只读配置不变，不直接变成可写轮 |

用户输入是用户发起继续工作的依据，不能等同于批准新增资源或所有未明业务选项。
Agent 仍须结合用户实际内容处理任务，未解决的决定不得虚构；平台不从合法闲聊自动生成批准事实。
仅允许已批准工作的继续，新增资源仍须 project_capability_scope_approved 等正式授权。
材料原因已知且非决策类时，正常模型交接不要求再补一次用户“继续”。

### 3.2 继续请求沿现有工作领取路径处理

以下为目标调用链，属于设计，不是当前全部已实现的源码：

```text
用户输入 / 验收反馈 / 平台条件变化
  → 记录现有待处理事实
  → Coordinator 领取
  → admitNode 核验当前身份、批准范围、阶段、Writer、候选及输入
  → 短事务 CAS + applyExecutionOutcomeTx + 放行回执
  → 原 Agent 实施，或现有验收路径领取
```

工作成功安排并有回执后才消费请求。暂时失败保留待处理事实。
无新材料、无条件变化且无进展时使用现有去重和退避，不无限启动模型。
输入回执不等于授权回执，也不等于交付通过。

### 3.3 阶段由当前合法状态决定

旧事件的 recoveryKind 保留为历史字段，不作为实际阶段的状态权威。
无 stamp 的旧事件也按当前合法阶段处理，不默认要求人工重新登记。
实施、结果收集、检查、集成与 architecture/acceptance 的转换须逐项列明，
不能统一拉回 implement。发现需要回到实施的范围内缺陷时，沿既有受控反馈路径处理。

activeReviews、存活 TaskRun、固定候选和 review generation 的保护保留。
验收放行后的唯一正常启动拥有者为 runTaskGraphCycle 的 verifying 扫描：
recoverGraphReview → verifyNode。同步恢复入口不再并行承担正常验收启动。
admitNode 在同一短事务保存 review ready 绑定、节点 verifying 和放行回执。
graphReviewClaimKey 使用绑定的 admit:<wake.id> 键，reserveGraphReviewClaim
在节点锁内用同一个键预留唯一事件；跨进程互斥依靠该持久事实，不依靠内存集合。
提交后启动前崩溃，由下轮扫描领取；预留后 TaskRun 绑定前崩溃，沿现有 review_retry
及 restart generation 接管，候选与既有 Writer 证明仍须核验。上述机制需用回归实证。
同步启动接口若调整为下一调度轮领取，必须更新契约和回归，证明重启后仍会领取、
并发不会重复启动；不能只改测试期待来掩盖丢工作。
用户通知使用实际处理阶段，不继续照抄旧 stamp。

### 3.4 兼容职责

旧 platform_preparation_registered 等事件继续幂等消费，旧绑定验证保留。
普通继续不要求生成新的单次准备回执。旧账本不清空、不批量改 attention、不重置预算。
restart-recovery 保留崩溃接管职责，repair 保留受控回修职责，不并入 admitNode。

## 4. 文件范围与删除清单

| 文件 | 计划修改 |
| --- | --- |
| src/lib/task-graph/conversation-followup.ts | 删除类别白名单及重复资格判断；保留动作解析、输入归属和交接身份；不能丢掉待解决业务决定 |
| src/lib/task-graph/conversation-inbox.ts | 核对 handoff 的边界契约与授权；收尾保留本次结构化原因；普通新输入沿原 Session 处理 |
| src/lib/task-graph/implementation-result.ts、execution-progress.ts | waiting_for_user outcome 传递并保存本次结构化 lastFailure；普通提问清理过期原因，继续复用现有字段 |
| src/lib/task-graph/restart-recovery.ts | 仅核对接管时结构化原因保留及现有验收领取；不合并职责、不增加恢复状态机 |
| src/lib/task-graph/preparation-recovery.ts | 删除第二份白名单；在现有 admitNode 内完成一致的执行边界和阶段处理；旧准备回执仍作兼容 |
| src/lib/task-graph/coordinator.ts | 删除已被统一入口承担的阶段重复拒绝；明确验收启动拥有者，保留真实互斥 |
| src/lib/task-graph/conversation-recovery.ts | 请求消费依据实际成功回执；移除以旧 stamp 决定实际路由的依赖，保留幂等和重试 |
| src/lib/task-graph/run-doctor.ts | 清理过时的预算/恢复审批结论；按账本事实显示未知和已核实，不预设 Reader/page_id |
| src/lib/task-graph/prompts.ts、coordinator.ts 的通用指令 | 使用任务材料、交付物等通用表述；缺材料不默认等于必须人工决定 |
| 现有 task-graph 测试 | 增加下表行为用例，优先真实隔离数据库和现有执行边界 |

上述文件是预计范围，不承诺未经实现验证的固定行数。
两份白名单与相关放行调用迁移在同一个实现提交完成，不留下半迁移状态。
只删除证明重复的检查，Writer/CAS/验收启动保护必须有明确归宿。
不增加项目名分支、恢复协议、配置白名单、Prompt 框架或第二套状态机。

## 5. 红绿验证

先让新增用例在基线失败，记录命令、退出码和实际失败断言，再实现并运行绿色回归。
通用用例使用虚构项目和任务键，不以真实业务名触发平台行为。

| 用例 | 必须观察到的结果 |
| --- | --- |
| 未解决业务决定 + 合法闲聊 + 模型建议继续 | 不执行待决定动作；身份合法不替代决定 |
| permission/scope 转为 waiting_for_user，再经收尾/重启 | 本次结构化原因仍在，普通提问不会继承过期原因 |
| 用户回复重定向到已批准工作，随后产生新等待 | 新等待记录本轮原因，不携带上一轮已过期 permission 原因；新增资源仍不可读 |
| 未知原因 + 模型 resume_implementation | 拒绝 materials 自我接续，不新增状态，输入及工作现场保留 |
| 未知原因 + 经核验用户 operator 继续 | 接回当前合法阶段；未授权目录仍不可读 |
| 未知原因 + 合法用户话题回复 conversation wake | 接回原 Session 的可写实施轮，可完成代码/测试，不要求特殊恢复命令 |
| 未知原因 + 只读问答轮 | 仍可查询已授权资料；不能写源码或未经放行直接启动写轮 |
| admitted 成功后再次等待 | 旧 lastFailure 清理，新原因不混入旧等待；历史审计事件保留 |
| 材料等待 + 房主合法输入 + 模型交接 | 接回原 Session、implement 和原候选；交接本身不增加或重置修复预算 |
| 重启接管后 waitingKind=question 的材料等待 | 仍可合法交接，不因 question 标签误拦截 |
| 新目录未授权 + 用户要求继续查已授权资料 | 原会话继续已授权工作；实际沙箱仍拒绝新目录 |
| reservation 后暂停原因/权限/候选发生变化 | 旧请求不能用过期 revision 放行，原输入不丢 |
| 直接调用导出 handoff 边界 | 绕过调用方也不能越权，边界独立成立 |
| stamp 实施后当前推进到 acceptance | 按当前合法验收阶段处理，通知一致，不拉回实施 |
| 无 stamp 的存量请求 | 按当前阶段处理，不要求新恢复审批 |
| 放行事务失败、提交成功但响应丢失 | 可以重试；最多一次有效放行，不提前消费 |
| admitted(verifying) 提交后崩溃，尚未调用验收 | 下一调度轮对固定候选恰好启动一次验收 |
| 验收 claim 预留后、TaskRun 绑定前崩溃 | 既有 restart generation 安全接管，无双 Verifier |
| 两个 Coordinator、已有活动 Verifier | 最多一个有效 Writer/Verifier，另一方不重复启动 |
| 任一生产路径改变 state/lastFailure/phase | revision 必须递增；旧 expectedRevision 不能写入 |
| 普通工程失败及范围内验收缺陷 | 原 Session/Worktree/候选持续，继续修复不受旧次数剥夺资格 |
| 无进展、配额不足、用户暂停 | 不无限模型调用；保存工作事实，暂停仍有效 |
| 候选漂移、Writer unknown、权限撤销、未合格上游 | 保留现场并拒绝受保护操作 |
| 旧准备回执重放 | 兼容消费幂等，过期候选绑定仍拒绝 |

复跑 admission、interactive-conversation、conversation-delivery、implementation-recovery、
review-platform-retry、prepared recovery，以及 W001、Sandbox Manager、Project Capabilities、
Git Integration 的受影响回归。执行前读取 package scripts 确认真实命令。
通过 check:long-files、类型检查与必要构建。该文档阶段未执行这些回归。

## 6. 执行资源与真实业务验收

工具资源装配是独立缺口。沿现有 approvedReadOnlyRoots 等批准输入机制核对必需依赖，
做真实沙箱可读验证；未授权目录继续不可读，不开放整个宿主技能目录。
资源修复若涉及新增批准范围，单独列出并取得授权，不能由继续请求隐式授予。
FANUC 已找到材料的事实应通过原任务输入通道交回原 Agent，不能伪造它已验证通过。
YIZUMI 的历史候选资格须核对，不能绕过未验收交付保护。

生产部署与 Reader/Mold 恢复在实现、隔离验证和审阅完成后，另取用户确认。
经授权后的业务验收要记录：原输入到原 Agent 的绑定、真实工具/代码/测试成果、
固定候选验收、后继释放，以及至少两个独立 Ticket 的真实 Codex 执行时间重叠。
剩余阻塞按实际原因统计，区分自动消化、用户决定与后继等待，不把 TaskRun completed 当 Ticket passed。
只有重新启动或卡片变绿不算业务验收通过。

## 7. 评审与提交规则

用户最新要求取消 antigravity 评审，由 pi-agent、kimi-code 参与评审，Codex 汇总并达成共识后再提交。本版已满足设计提交条件。
平台一次只允许一个 canonical handoff，因此依次评审；不把房间成员替换成私有子 Agent。

| 评审者 | 核心问题 | 本稿评审状态 |
| --- | --- | --- |
| pi-agent | 调度职责、重复判断删除、资格/授权边界、资源装配与历史兼容，是否新增隐性人工门禁 | 通道拆分认可；只读轮不得开写要求已纳入 |
| kimi-code | 稳态业务决定绕过、并发 CAS、阶段 mismatch、验收唯一启动及请求消费 | 认可通道拆分；conversation 绿用例与只读约束已纳入，无其余阻断 |

每位评审给出同意项、阻断项、源码依据、需要修改的具体段落和验证用例。
顺序为 pi-agent → kimi-code → Codex 汇总。不再交接给 antigravity。
评审者可在自身回复中保留对后续评审的交接，最终交回 Codex。
Codex 修订后逐项列出回应；实质变更须由受影响评审者复核。
pi-agent、kimi-code 与 Codex 对同一最终版本无未解决阻断项才记录共识并提交，不把沉默视为同意。
## 8. 评审结论与提交范围

- pi-agent 房间消息 cmvjh05ri06whuudzu6oqtxp5，2026-10-22T11:41:20Z：
  认可模型 materials unknown 拒绝、用户 operator 继续开放；要求只读轮不得开写。
- kimi-code 第二版复核 cmvjgtsyy06rzuudz645a82ds：认可复用 lastFailure，要求钉死默认规则与原因清理。
- kimi-code 随后在本轮回复撤回 materials 默认放行建议，认可 pi 的通道拆分；
  要求显式补 conversation wake 的正常用户回复继续与绿色回归，明确只读轮不变。
- Codex 采纳上述意见，§3.1 与 §5 已纳入所有文本条件；本版无未解决的设计阻断项。

以上是设计共识，不是测试通过或生产恢复证明。只提交本文件，不把用户原有未跟踪文件夹、
业务实现或运行账本带入提交。实施、隔离红绿验证与另行授权的生产部署/恢复仍未完成。
