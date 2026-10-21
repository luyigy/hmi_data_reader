# Autonomous Progression Simplification Audit

## 结论与审计边界

目标是批准后自动消费 Task Graph，并让原 Coding Agent 在批准范围内持续工作。当前主要障碍在 **工程结果到调度结果的转换**，不是缺少更多 Prompt 或恢复协议。平台已有并行、原生 Session、自动回修和冲突修复能力，却把多种尚可处理的障碍转换成需要外部触发的暂停。

固定源码基线：`oss-prep@bac31f2`，包含授权衔接修复 `8a15eee`。业务账本采样于 **2026-10-21 19:19:10–19:19:14 CST**；随后读取相同节点的结果摘要、资料查询事件和 Git 状态。路线 `cmvdmf87w043f9xhgf9yvua6p`。证据在 `docs/evidence/autonomous-progression/`。

本轮只读生产数据库、源码和 Git 工作区；新增文件只有本报告及审计证据。不调用恢复、预检登记、材料发布、Issue 实时派发检查等有状态接口；不修改生产任务、预算、批准快照、宿主策略或业务代码，不部署。`task-graph:doctor` 的 not_verified 不等于已经确认缺失。报告中的可自动处理指实施建议后应由平台处理，不代表当前版本可以立即恢复。

## 1. 产品默认行为

- Ticket 批准后，平台负责持续推进。一次模型回复结束不应默认终止 Ticket。
- 原 Agent 自主找资料、编码、调试和修复；未交付的正常交互回到原实施入口与原 Session。
- 缺材料先使用当前任务、历史消息、仓内资料、已授权附件和项目来源。可继续的独立工作先做；数据不得虚构，缺失验收证据不得算通过。
- Worktree 中独立实施尽量并行；实际集成冲突在受控合并阶段处理。不能仅因两个任务可能修改同一文件提前串行化。
- 只因真实的人类决定、不可替代的信息或安全边界暂停相关工作。平台故障由平台处理，其他独立 Ticket 继续。

## 2. 当前实际调用链

```text
飞书批准卡
  proposals.ts:157 handleGraphProposalCardAction
    :237 createTaskGraphRun → store.ts:71 releaseReadyNodes
      coordinator.ts:718 runTaskGraphCycle
        inspectIssueDispatch                       校验批准范围是否漂移
        claimNode / claimExecution                 节点与执行 CAS
        executeJob (:420)
          ensureIntegrationRef / ensureJobWorktree  原仓身份与独立 Worktree
          prepareGraphSpecInput / prepareUpstreamInputs
          implementationConversation              原参与者与原 Codex Session
          executeAcpxTaskRun
            W001 StageExecutionRequest / Dispatcher
            runner-harness.ts:186 prepareTaskDeclaredRuntime
              Project Capabilities → Scope → Runtime Pin
            runner-harness.ts:230 → Sandbox Manager → Bubblewrap
          保存候选与解析实施结论
          检查 → integrateJobWithRetry / 冲突修复
          completeExecution → markNodeIntegrationsReady
        verifyNode                                  固定候选，独立架构/测试验收
          submitNodeVerification → scheduleGraphRepair（范围内缺陷）
        releaseReadyNodes                           满足真实依赖后放行
```

正常聊天与恢复的旁路在 `conversation-inbox.ts`、`conversation-followup.ts`、`conversation-recovery.ts`；人工平台准备在 `preparation-recovery.ts`。协调器虽扫描 `running/attention` 路线，但主派发循环只领取 `ready` 执行；既有 `attention` 必须匹配专用恢复、收到用户输入，或有恢复请求/准备回执，不能普遍自行推进。

### 并行事实

- `coordinator.ts:66` 最大实施/对话槽为 4；`:756` 按 `activeJobs + activeConversations` 控制。验收另由 activeVerifications/activeReviews 控制，不能把所有模型总并发都报告为 4。
- 同主仓的实施 Worktree 没有按潜在同文件冲突串行。仓库锁只包住准备、提交和集成临界区，不包整个模型实施。
- `store.ts:92–128` 另有 extraRepositories 门禁；存在 write 访问时与其他 claimed/verifying/attention 节点互斥，attention 也可长时间占住。这针对真实共享额外工作区，不能简单删锁；有写需求应先使用该仓自己的受控 Worktree。
- 本 Reader/Mold 路线的 R6/M6 extraRepositories **全部为 read**，该写互斥不是当前停滞原因。R6_ARBURG/FANUC/NISSEI/YIZUMI/BOLE 都只直接依赖已经通过的 R05，本来可并行。

## 3. 停止入口完整清单（本次源码范围）

下表按语义归为 **24 类**，不是声称有 24 行代码。其中 21 类在当前生产调用链可达，另 3 类（18、19、24）是仍暴露的兼容/运维函数，本基线 src/scripts 未发现直接调用，不把它们计作当前生产正在发生的故障。覆盖当前 `src/lib/task-graph` 的直接 attention 写入、中央 outcome 分支及其错误发布入口；原始静态命中保留为 `halt-sites.txt`。另外扫描了 src/lib 下其他模块的 TaskGraphNode/Execution 状态写入，本基线未发现额外直接写入者。外部 Harness、服务、资料错误经下列入口转换。

| # | 真实入口 / 触发条件 | 当前停法 | 判断及最小方向 |
|---|---|---|---|
| 1 | coordinator:568–576，正常回答/提问 | attention / waiting_for_user | 保留真正待输入；不能把轮次结束当任务结束 |
| 2 | implementation-result:55–59，missing_business_material | 无条件转 waiting_for_user | 缺少查询未完、配额及可继续工作判断；先交回原 Agent |
| 3 | implementation-result:60–65，scope_change / permission_required | waiting_decision | 批准范围确实不足时保留；不是所有 blocked 都自动续写 |
| 4 | 同上，environment_failed 非 transient 或未给 cause | waiting_decision，owner=platform | 技术原因缺字段就停；依据真实故障/预检处理，而不是要求 Agent 填更多标签 |
| 5 | coordinator:627–637，Runtime missing / invalid | decision_required | 缺资源可由平台恢复已批准资源；越权、资源身份漂移仍拦 |
| 6 | coordinator:638–650，Spec/上游包/临时服务准备失败 | implementation pause | 区分资源可准备、依赖未齐与真实权限问题 |
| 7 | coordinator:685–690，未被 transientPlatformCode 识别的普通异常 | decision_required | 兜底把未知工程错误交给人；先平台诊断或原 Agent 调试 |
| 8 | coordinator:653–663，检查失败 | repair_required，最多 2 次后 exhausted | 已有自动回修；生命周期累计次数过粗 |
| 9 | coordinator:568–580，交付标记缺失/格式错误 | collect_result，formatAttempts=1 后 exhausted | 协议不是业务失败；优先补收既有结果，不重做实施 |
| 10 | integration-retry.ts / execution-progress:229–235，集成引用变化 | integrationAttempts 到 3 后 exhausted | 普通并发竞争；短重试后等新的集成条件，不要求人重新批准 |
| 11 | coordinator:667–683，冲突检查或 checkpoint 构造失败 | waiting_decision | 混有真实不安全冲突与平台处理大差异失败，不能全称人工合并 |
| 12 | coordinator:544–551，冲突 Agent 输出 blocked | waiting_decision | 普通缺信息/工具错误也停止；范围改变或不可裁定语义才需人 |
| 13 | repair.ts:13–49，独立验收发现范围内缺陷 | attention 后回修；预算满则 exhausted | 保留独立验收；消除事件次数与 progress 次数两套预算门槛 |
| 14 | review-contract.ts / store.ts:315–327，blocked_require_human | attention | 目前审查失败分类只有范围内缺陷/需人，平台准备类障碍容易落错类 |
| 15 | review-publication:18–44，审查执行失败/暂时故障 | platformAttempts=2 后 exhausted | 与实施共用累计平台计数；故障条件已变化仍可能永久停 |
| 16 | 同上，审查协议补收耗尽 | 直接 retry_exhausted | 协议与交付资格分离；不能把未读到格式当必须业务决策 |
| 17 | review-publication:48–69，验收工作区/工具预检失败 | retry 或 ownership_mismatch | 普通未识别准备异常会被命名为归属错误；真实身份问题才算安全阻塞 |
| 18 | store.ts:362–386，recordExecutionIssue 通用/旧入口 | 四种 issue 一律 attention | 兼容入口仍可绕开细分类；应汇入中央已有 outcome 决策 |
| 19 | store.ts:398–420，旧格式 stale claim | attention | Versioned 路径已有 Writer 探针；不能将超时或旧字段不足当退出证明 |
| 20 | issue-dispatch.ts:13–48，Issue 范围/依赖变更 | 受影响未来节点及后继 attention | 真正批准漂移保留；API 临时不可达已有自动重查，不应再加人工恢复 |
| 21 | conversation-inbox:190–206，新输入到达集成切点 | waiting_for_user / attention | 有待处理输入，不等于要等更多输入；现有 reconcile 可接回，需减少旁路 |
| 22 | restart-recovery:45–109，重启后工作区不符、旧 blocked、已问问题 | waiting_decision / waiting_for_user | 身份不符保留；重放旧 blocked 不能永远覆盖已改善的条件 |
| 23 | store.ts:332–359，人类验收明确拒绝 | attention | 若批准中要求人验收则保留；范围内具体缺陷仍可回原 Agent 修复 |
| 24 | reclassify-delivery.ts:9–56，撤销未经验证的交付 | attention，撤销 passedAt | 质量保护保留，随后应按实际缺项交回原实施，不永久冻结 |

**旁路门禁虽不直接写暂停，也会让暂停无法结束：** `scheduleImplementationRecovery` 的 waiting_decision/预算限制、`scheduleVerificationRecovery` 的状态限制、`preparation-recovery.ts:103` 的 source.commit、`conflict-repair-recovery.ts:13` 只接管 requiresUserDecision 尚未定义的旧记录、`conversation-followup` 的只读工作区及材料交接协议。它们不是另外一套暂停计数。

## 4. Reader/Mold 现场量化

24 个节点：**12 passed、6 attention、6 planned 等依赖**。6 个暂停节点的 Writer 均由只读探针确认为 exited；批准快照行绑定一致。未调用会写状态的 Issue freshness 检查，未将环境/材料未验证项当作已经通过。

| 节点 | 当前合法保存点与事实 | 自动处理方向 | 人类是否必需 |
|---|---|---|---|
| R6_ARBURG | implement / waiting_decision；HEAD、workspaceBase、candidate 均 f12e3ac，正是 R05 交付；工作区干净。消息却显示最新集成 d682493 | 以 Stage 当前保存点为权威，修正 coordinator:494 把 integration.commit 称作当前基线的输出；指定测试文件尚未创建也不应自动当环境缺失，原 Agent 应在本票范围补齐。原 Agent 从保存点继续。先确认无真正批准输入漂移，不强制 checkout 最新分支 | 尚无证据需要用户重新决定 |
| R6_BOLE | acceptance / exhausted；候选 e11cef0，platformAttempts=2；旧 source=null，已追加 v2 批准 | 从当前批准与真实预检判定旧平台故障是否消失；恢复现有验收阶段，不重新实施、不伪造旧 source.commit | 当前是平台门禁；样本独立性仍须验收，可能最终需要人补不可替代真值 |
| R6_FANUC | integrate / waiting_decision；候选 c4b213a，MERGE_HEAD=d682493，3 个明确冲突路径 | 保留待合并现场；修复差异读取的流式摘要/文件级散列，不增加 maxBuffer；随后走原 Agent 的受控冲突 Stage、验证和独立验收 | 当前并无必须人裁定语义的证据；后续如出现真正业务取舍再问 |
| R6_NISSEI | implement / waiting_for_user；候选 2d0eb99；6 项通过、独立留样项未过。当前轮实际 39 个成功资料查询事件，返回 780 条记录引用，最后 hasMore=true，broker 下载事件为 0 | 这是未完成的授权搜索，应保存查询进度、在下一正常轮次继续并选图验证；不能把 429 或仍有下一页直接变成人工缺图 | 未证明不可替代信息确实不存在；完成搜索后可能需真值或留样裁定 |
| R6_YIZUMI | implement / waiting_for_user；候选 0a6cff0；旧包回归通过但没有新增原屏交付 | 查询事件分别使用 31、伊之密、1、*，均 0；来源实际搜索字段为机台号，* 是字面量。此前宿主用 30 已取得 5 条记录、下载 4 图。把已有授权来源和取图证据接回原 Agent，提供范围内有界浏览，避免猜检索词 | 当前没有必要让用户重发已存在图片 |
| M6_DEMAG | prepare / waiting_decision；候选 2a3bf03，尚无实施 TaskRun；Reader 输入含未通过 BOLE 历史提交 | 真实交付资格保护要保留。应自动等待 BOLE 合格后重新固定输入，不要求人为恢复一次；不能反复重试相同不合格版本 | 当前无需新增用户决定，但不能现在就执行不合格输入 |

计数口径：**4/6 为明确的平台/控制流修复对象**（ARBURG、BOLE、FANUC、YIZUMI）；**1/6 应继续自主资料调查**（NISSEI），能否最终满足留样条件尚不确定；**1/6 应自动等待依赖事实改变**（M6_DEMAG）。**已证实必须立即由人做的新业务/权限决定为 0**，不代表全部任务必然可无人完成。BOLE/NISSEI 留样资格仍有未解决的证据风险。6 个 planned 后继当前等待是合理的，不能算 6 个额外人工故障。

数字说明：日精 Agent 摘要声称扫描 760 条；账本有 39 次查询、共 780 条返回引用，未据此声称 780 个独立或去重样本。发那科只读流式测得差异 **52,816,837 字节（约 50.37 MiB）**，而 `git-command.ts:15` 使用 4 MiB maxBuffer；命令本身退出 0。证据是原冲突路径以外差异，不代表冲突文件本身有 50 MiB。

## 5. 哪些边界保留，哪些权威应收敛

| 机制 | 正确职责 | 当前过度/错位点 | 方案 |
|---|---|---|---|
| Ticket 批准 / Issue 快照 | 目标、范围、真实依赖 | 为同一范围的工程续跑反复索要批准 | 原批准持续有效，只有实质范围/权限改变重新批准 |
| Sandbox / Project Capabilities | 限制可见资源与写入，执行当前明确授权 | 把所有准备失败都等同于权限决策 | 未授权仍拒绝；已批准资源的准备和查询问题自动处理 |
| Runtime Pin | 工具、目录、源码与资源可复现 | 混为调度资格或平台代码版本权威 | 保留资源一致性校验，供运行准备使用；不审批 Ticket 续跑 |
| Scope v2 | 明确授权变更的证据，关联旧 pin | 为正常重试再制造一次批准动作 | 已有批准直接消费；仅权限范围真的变更时使用，不撤销当前 v2 保护 |
| source.commit | 工具来源的版本线索 | preparation-recovery:103 把 host_registration/source.commit 当平台修复版本证明；null 就无法恢复 | 不从工具声明推断平台版本；平台恢复根据真实失败条件是否消失与已有执行证据 |
| Writer 与候选 CAS | 单写入者、当前输入、结果归属 | 在关键交接前后重复校验看似繁琐 | 这是 TOCTOU 保护，必须保留；统一调用实现，不删除检查时点 |
| retry-limits / repair.ts | 有限的无进展重试，防止无界成本 | 跨阶段累计 platformAttempts；repair 事件次数与 progress 次数两套门槛；old failure 影响已变化条件 | 中央 outcome 为唯一记账入口；预算约束相同失败上下文的无进展重试，既有累计记录不清零 |
| review-publication.ts | 发布独立验收结果 | 还硬编码 >=2，和 retry-limits 重复；协议、平台、业务失败各自不同人工分支 | 共用现有预算判断，平台故障不混入业务失败，不增加一组 enum |
| Node / Execution 状态 | 节点汇总与执行阶段 | 多个恢复模块独立决定“能不能继续” | 协调器消费同一事实与中央 outcome；不另建调度器/持久状态机 |
| W001 Stage Request | 当前 Stage、权限、输入、输出一致性 | 不能由历史 Session 覆盖当前要求 | 保留；它不应审批是否续跑，也不为解决正常障碍增加 Prompt |

资源预检两次比较授权、Writer 在交接前再次探测等，不是可以随意删掉的重复检查。要去掉的是多套**推进资格的解释**，不是安全边界在不同时间点的校验。

## 6. 最小可实施方案：两个可见闭环

### A. 原 Agent 持续实施与授权资料续查

用户可见结果：ARBURG、YIZUMI、NISSEI 从原保存点并行工作；普通资料问题不需要用户再发 resume。

- `coordinator.ts`：当前保存点与最新集成版本分开呈现；同一 Ticket 普通工程障碍交回原实施入口，不把所有 blocked/未识别异常都转 decision_required。
- `implementation-result.ts` + `conversation-inbox.ts`：真正需要输入才 waiting_for_user；可继续工作的轮次走已有 ready/implement 路径，原 Session、candidate、Worktree 与 Writer 交接保持。状态询问不产生写入或恢复请求；已批准工作自身的自动推进不依赖状态询问。
- `project-capabilities/runtime.ts` + `table-data.ts` + client：已有 query 在批准来源内支持有界浏览，持久化已有查询回执中的 cursor/查询身份，让限额后的下一轮能续查。保留 40 请求/轮限制、字段/来源限制、附件版本和查询归属检查，不单纯提高额度；不新增任意 URL 或跨表读取能力。
- `conversation-followup.ts`：未交付、无安全阻塞且已在批准范围内的普通会话不绕到只读 Followup 再用标记请求交回；历史 Followup、已交付与验收中只读会话兼容。`conversation-session.ts` 继续持有原实施者身份。
- 本轮不改 Prompt 条款来保证“先搜索”；通过工具能正常浏览、返回真实限额信息、记录续查位置和正常轮次调度，使原 Agent 可以执行这项工作。不得机械要求 Agent 必须扫描所有记录后才能请人；有具体范围外决定或不可替代信息时可直接提出。

### B. 平台故障与受控集成自动推进

用户可见结果：FANUC 在原合并现场自动完成冲突处理；BOLE 进入真实独立验收；合格后 M6_DEMAG 和其余 Mold 后继自动启动。

- `execution-progress.ts` / `retry-limits.ts` / `repair.ts` / `review-publication.ts`：收敛同一失败的记账和推进判断。正常分页/工作轮次不算失败。保留历史计数；同一失败条件下重试耗尽不得无限循环，但新的**已验证条件**可以重新评估推进，不要求人手动登记准备证明。
- 复用已存的 failure fingerprint、Stage、输入/资源身份、scope 批准和实际检查回执判断条件是否变化；不能只凭模型一句“已修好”、一个新 commit（尤其仅文档变化）或重复新建请求 ID 获得尝试。预算策略属于此次实施需要明确的行为变化，必须通过测试后批准上线，本审计不把现有 exhausted 行直接改 ready。
- `coordinator.ts`：在既有循环统一检查可推进的工程/平台等待。安全事实未满足就不派发；已满足就经中央 outcome + CAS 交回对应阶段。实现/验收的原生 Session 与角色不串用。
- `runtime-continuity.ts`：运行前的资源一致性校验与协调器的只读条件复查共用同一实现；真正启动仍校验当前 Writer/claim，不为 exhausted 的诊断伪造活动执行。
- `preparation-recovery.ts`、`conversation-recovery.ts`、`conflict-repair-recovery.ts`：普通工程推进不依赖这些专用人工回执/旧字段格式；人工入口仍可作明确例外或诊断，不新增另一个“恢复证明协议”。消除 requiresUserDecision 是否恰好 undefined 才能自动处理的旧格式条件。
- `git-command.ts` + `conflict-repair.ts`：对大差异使用流式或 Git 对象/文件级摘要，保持同样的冲突外内容不变证明；不提升 maxBuffer，不放宽允许冲突文件、候选父提交、nonce 产物或最终验证。
- `upstream-inputs.ts` 保护不删除；等待输入合格版本时由协调器依据既有依赖/交付事件重检，M6_DEMAG 不因“暂时没有合格输入”要求人再恢复。

这两步均在现有 Coordinator / ExecutionProgress / TaskGraphEvent 内实现；不引入 Gardening、第二套任务状态、后台恢复 Agent、资源池、Task Graph 重建或新恢复命令。不是两张横向“搭框架后才见效果”的任务：A 完成即能看到原 Agent 并行推进，B 完成即能看到冲突合并、独立验收和 Mold 消费。

### 目标控制流（伪代码，不是新增状态机）

```text
每轮既有 Coordinator：
  读取批准范围、当前 Stage/保存点、待办输入和真实执行证据
  核验 Writer、候选/输入身份、权限及 CAS
  若安全边界不满足：只阻塞相关工作；需要新批准时提出具体决定
  否则若依赖成果尚未合格：等待对应交付事实变化，其他独立 Ticket 继续
  否则若已交付：保留独立验收与后继放行条件
  否则若工作未完 / 查询轮次结束 / 可修复错误：
    在失败条件与预算允许时，接回原 Agent、原 Session、对应 Stage
    真实已验证条件变化时重新评估，历史预算记录不清零
  否则若确实只差人类决定或不可替代信息：
    保存已完成工作；仅问必要问题；其他 Ticket 不停
```

## 7. 原路线的恢复顺序（实施获批后的方案，当前不执行）

1. 从本次 `snapshot.json` 重新采样每个候选、revision、Writer；新状态变化一律重新核验，不能拿本报告当恢复许可。
2. A 上线后优先并行 ARBURG、YIZUMI、NISSEI。使用各自现存 Worktree 和原 Session；不改旧批准快照，不把新集成 d682493 强灌入尚在 f12e3ac 的合法保存点。最终集成时按新主线受控合并。
3. B 上线后 FANUC 从 c4b213a + MERGE_HEAD d682493 的现存现场接回 integrate，不能重跑空白实施或丢弃冲突。BOLE 从 e11cef0 接回 acceptance，用已授权新材料；独立留样是否合格由实际验证决定。
4. BOLE 通过后自动重检 M6_DEMAG 的输入历史；所有 M6 各按其 Reader 交付放行，不能等齐所有 Reader 才开始第一个 Mold。最后 M07 仍按既有真实依赖汇合。
5. 如授权范围仍不够、Writer unknown、候选发生变化或独立样本确实不可取得，只停对应节点并准确说明需要的决定；不重置预算、硬标 passed 或清理现场。

## 8. 可执行验收标准

### 隔离红绿回归

- 资料查询返回 429 且最后一页 hasMore：当前候选和 cursor 保留，下一正常轮次续查，原 Session 不变；未授权来源仍拒绝。
- 条件未变的相同失败：不形成无限重试；真实预检/输入条件改变后能重新评估，累计预算历史不清零；模型自述、仅文档提交不能解锁。
- 带 v2 批准且 source=null 的旧 pin：不伪造 source，不索要新人工准备协议；对同一候选自动进入合法验收。原权限漂移检查仍拒绝无批准变更。
- 50 MiB 以上冲突外 diff：原 Git 4 MiB 缓冲场景红；修复后证据完整，原 Agent 受控解决三文件；修改额外文件/错候选/Writer 存活仍拒绝。
- 原保存点与最新集成不同但各自身份正确：允许原 Agent 实施；真正 HEAD/candidate 不符仍拒绝。
- 同仓两个独立 Worktree 修改同文件：两者实施时间区间重叠，实际冲突在集成处理；未验收成果不放行。
- 普通提问、补材料、已交付/验收中只读、历史 Followup 均兼容；可选 verify skill 不存在不能单独导致失败，显式必需技能资源仍完整校验。

### Reader/Mold 真实业务验收

验收以**可运行功能**为标准，不以 passed 数量代替：

- 记录至少两个独立 Reader 的真实 Codex 执行时间重叠、Worktree、原生 Session、Manager 进程和 Writer 退出证据；它们不因可能改同文件先串行。
- 各品牌从真实授权图片得到实际 OCR 结果；未知/缺失/低置信不被补成真值；独立留样与开发曝光严格区分。
- Reader 的真实 HTTP 上传、CLI 和冻结包读取/重开返回一致的 page/profile/version 与字段语义；跨仓版本固定到已验收成果。
- Mold 页面加载 Reader 合格固定包，真实编辑、保存、关闭重开，并用 API 读回验证；未实现或未验证项明确列出，不能从现有回归推断 Model/Mold 闭环已完成。
- 一个 Reader 通过独立验收后，其 Mold 后继无需用户再次输入 continue 即启动；一个分支真正需人时，另一个分支继续运行。
- FANUC 合并与 BOLE 验收成功后，M6_DEMAG 自动接回；最终列出每个业务功能、测试/页面/API 证据、完成项与剩余阻塞。
- 目标是将当前 6 个 attention 中**没有已证实人类决定的工程障碍**交给平台和原 Agent 自动处理；不承诺未经验证的样本一定足够，也不为追求零 attention 放松安全或验收。

## 9. 不应再做的事

不针对 BOLE/FANUC/DEMAG 新增按 Ticket 名称判断的分支；不增加 Prompt 标记保证自主性；不统一提高 timeout、maxBuffer、配额或重试次数；不清空旧预算；不改工具 source 冒充平台来源；不把 scope 批准当作通过验收；不绕过原恢复保护直接更新生产状态。本轮到审计与设计结束，等待对最小方案的实施批准。
