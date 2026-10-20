---
doc_type: ARCH
doc_status: proposed
---

# Ticket Agent 自主性：A / B 实施边界合同

承接 [512 提案](512_PROPOSAL_20261020_TicketAgentAutonomy.md) 与 [513 诊断](513_REPORT_20261020_TicketAgentAutonomyDiagnosis.md)。本次核对基线 `bbc574d`，其业务源码与 `8b8970a` 相同。本文件定义待确认的实施范围，不表示已实施、部署或通过验收。

## 顺序和停止条件

只做两个独立提交单元，A 通过后才做 B，最后进行一次真实 Codex + 飞书 Topic 的隔离端到端验收。每步保留同一失败测试的修改前、修改后输出。任一安全门禁失败先定位，不通过放宽断言、固定等待、补 Prompt 规则或增加恢复状态过关。

不恢复现有生产 Ticket，不修改其账本或批准快照。部署、生产授权配置变更与存量任务恢复不包含在“确认设计”中。本轮先提交这份合同供审阅。

## 共用的接续判定

“未交付”只是必要条件。先检查原批准路线、execution/TaskRun 归属、工作区与候选、当前阶段、消息来源、原恢复预算及 Writer 证明，再决定能否领取。正常新输入不代表验收已通过，也不授予新的资源权限。

| 现有状态或事实 | 新消息如何处理 | 是否可恢复写入 |
| --- | --- | --- |
| 实施 Writer 仍活跃 | 持久 Inbox 后使用原生 Steering；投递未知时不盲目重放 | 仅原 Writer 继续，不另派 Writer |
| implement 正常等待，`waiting_for_user`，含 answered | 有有效新输入且原 Writer 已证实退出，锁内重核身份后由原 Coordinator 领取 | 可以，在原 worktree/native session 中继续 |
| 新产生的普通材料等待、补图或纠正 | 使用现有正常等待语义；原 Agent 在实施轮次重新核对材料，材料不够时继续提问 | 满足共用门禁即可继续调查；不把输入当成材料已合格或已通过验收 |
| 上游依赖尚未完成 | 材料可保存在 Inbox，等待原依赖放行 | 不可以，不通过聊天跳过依赖 |
| 前置已完成但固定包、合同绑定仍不完整 | 归平台准备与绑定校验；复用现有 preparation 回执 | 绑定完成前不可以，不混作普通问答等待 |
| environment_failed / missing_capability 或资源预检失败 | 归平台准备；能力变化必须有对应资源身份和预检证据，复用准备回执及原预算语义 | 仅环境已验证、恢复授权有效后才可以；新消息本身无效 |
| 有证据的暂时环境故障 | 使用原 platform_retry 及分类预算 | 仅按既有有限重试，不重新定义额度 |
| check / integrate / architecture / acceptance 或已 integrated | 保持阶段所有权；聊天进入受保护的只读路径或排队 | 不从聊天直接切回可写实施；范围内缺陷走原有限回修 |
| 已通过或已交付的固定成果 | 兼容只读问答，新修改按既有受控回修/新范围处理 | 不因普通消息开放已封口成果 |
| Writer unknown、归属冲突、进程仍未退出 | 保留输入和现场，报告具体无法接管证据 | 不可以；不把时间、PID 不存在或缺登记单独当成退出证明 |
| scope_change / permission_required 或真实业务决定待裁定 | 等待相应范围、权限或决定的可核验授权 | 不可以；“继续”不扩大已批准范围 |
| `exhausted` 或当前类别预算已按原规则耗尽 | 保留现场，交平台制定新修复措施 | 不可以；不重置计数，不借普通等待绕过 exhausted |

预算按类别及现有 `executionRetryLimits` 解释，不能把任意计数等于上限简单当成所有工作都 exhausted。正常等待及用户材料输入不扣失败预算，也不增加预算。已暂停的准备或修复仍须使用原合法恢复入口。

判定属于原 Inbox/Coordinator 的领取前检查，不新增持久状态枚举。退出观察在事务外；锁内使用 P0 的精确身份快照校验、claim/revision、候选和幂等键。观察后任何身份或阶段变化都拒绝旧领取，不把慢进程检查重新放回长事务。

## A：Runtime Capability Preflight

### Discover / Authorize / Mount / Verify

| 步骤 | 输入与产物 | 禁止行为 |
| --- | --- | --- |
| Discover | 现有版本化 RuntimeDeclaration 增加可选 `skills` 需求，描述 skill ID、固定包根及摘要、必需文件、包内校验脚本；解析安装入口与实际依赖，形成候选清单 | 不从 Prompt 文本猜测技能路径；发现不等于授权 |
| Authorize | 候选实际路径必须同时属于宿主 project-capabilities 授权和该测试路线获批的 readOnlyRoots；复用现有声明哈希与 claim 资源固定机制 | 仓内声明不能自授宿主权限；符号链接本身不能扩大授权 |
| Mount | 只读挂载获准的明确包目录及依赖；任务私有配置沿用原机制；记录实际清单与版本身份 | 不递归放行任意链接目标，不挂载整个 HOME，不关闭 Bubblewrap strict 模式 |
| Verify | 在与实际 Harness 相同的 Bubblewrap 参数装配路径、身份和挂载清单下，检查正文、Codex 映射、所有声明依赖与 playbook，并运行包内校验脚本 | 不能只查宿主路径或 SKILL.md；不能任意执行仓内声明的宿主 Shell 命令 |

首个需求只接入 poteto-mode。必需清单包含 `SKILL.md`、`references/codex-tools.md`、匹配的 Feature/Bug fix/Refactoring/Session pickup playbooks 及 `.agents/playbooks/ap-task-graph.md` 的实际校验。校验脚本须是获准包内的固定文件，通过明确 Node argv 执行，禁止自由 Shell 字符串。包内引用指向未授权资源时预检失败，不能自动补挂载。

技能摘要进入现有资源 identity 和 attempt 回执，校验 exit code、文件摘要、挂载清单及项目适配检查输出一并留证。启动前、实际启动时的资源身份不一致则拒绝；同一 claim 中不静默更换技能版本。校验在隔离工作区与输出目录执行，不写共享源码或宿主技能包。

现有 RuntimeDeclaration 的 browser/ocr 声明与旧 pin 保持兼容；没有技能声明的旧 attempt 不被原地补写。获批快照缺少技能资源授权时明确失败，不能借 A 自动扩大现有生产路线。

### 文件与接口

| 文件 | 计划变更 |
| --- | --- |
| `src/lib/task-graph/runtime-contract.ts` | 声明解析中增加可选技能资源需求，复用 RuntimeResource 的路径/摘要；不新增授权配置来源 |
| `src/lib/task-graph/runtime-preflight.ts` | 解析、授权交集、摘要及依赖清单；返回已授权技能资源给 Harness |
| `src/lib/task-graph/skill-resource-preflight.ts`，新增小模块 | 使用现有 Bubblewrap 构造器执行完整包验证；纯宿主检查不能替代该验证 |
| `src/lib/acpx/runner-harness.ts` | 在完整资源装配后、模型执行前调用预检；execute/resume 均使用同一装配结果 |
| `src/lib/task-graph/runtime-continuity.ts` | 将验证证据绑定到现有运行资源身份及 TaskRun/claim；兼容旧 pin，身份漂移拒绝启动 |

`harness-runtime.ts` 原有私有 HOME、凭据刷新机制与 `bubblewrap.ts` 的严格边界优先不改，技能实际目录经已有 readOnlyPaths 补全。若实际测试证明必须改其接口，先记录具体调用方及理由，不顺便重排模块。

### A 的失败测试和证据

新增 `tests/task-graph-skill-runtime.test.ts`，由既有临时 PostgreSQL runner 登记。覆盖真实 Bubblewrap 下有效技能链接、包内映射/脚本/依赖、执行与续接同资源、未授权目标、依赖缺失、错误摘要、预检后资源漂移和宿主私有目录不可见。先在旧源码证明必需技能不可用，再以相同场景证明完整验证成功。失败时模型调用数必须为 0。

回归 `task-graph-runtime-pinning`、`task-graph-sandbox`、`project-capabilities-c01/c02`。证据包含同一红绿用例、实际包摘要、Bubblewrap 读取及校验输出、退出码、TaskRun 归属；测试政策文件、资源声明与授权只用于隔离测试项目，不更改线上配置。

## B：Normal Ticket Continuation

### 新路径与兼容路径

新产生的正常等待与普通材料澄清统一使用原实施入口：原 Inbox 记入消息，原 Coordinator 检查资格并领取，`implementationConversation` 恢复原 native session，`executeJob` 在原 job worktree 工作。该路径不产生只读中转 `graphConversation`，不要求模型输出 `resume_implementation`。活跃 turn 继续复用 Steering。

历史 `conversation_followup_reserved/bound`、未完成投递、旧 `TASK_GRAPH_CONVERSATION` 输出保留既有 adapter。已开始的历史 Followup 先按原归属收尾，不与新实施领取竞争。历史材料暂停仍按原状态处理，不批量改成正常等待；存量生产任务不会因本次部署自动迁移或恢复。已交付或受保护复核中的只读会话继续保留。

新旧路径共用现有输入 receipt、根输入谱系及 execution 锁，不能分别消费同一输入。无 native session 身份时保留现有降级记录，不能把新 Session 冒充原生连续性；真实验收必须单独确认 Session 连续性。

### 文件与接口

| 文件 | 计划变更 |
| --- | --- |
| `conversation-inbox.ts` | 将接续资格和正常重领集中在原 reconcile 路径；复用身份快照、receipt 和原事务操作 |
| `implementation-result.ts` | 新产生的普通材料等待归正常等待；真实环境/范围/权限暂停保留原类别 |
| `execution-progress.ts` | 如需要，扩展现有 outcome 校验以保留等待原因及原候选；不新增状态，不重置预算 |
| `coordinator.ts` | 原实施入口消费符合条件的下一 turn；普通回答不进入交付/失败补收，正式成果仍走原检查和验收 |
| `conversation-followup.ts` | 新正常等待不再进入只读握手；保留历史、已交付及受保护阶段的兼容处理 |
| `prompts.ts` | 删除平台内部接力与控制行要求，保留目标、可用工具和正式提交成果方式；不添加新的规则段落 |

`conversation-session.ts`、`acpx/runner.ts` 的 Session 归属和 graphExecution/graphReview 权威校验优先保持，调用方复用既有接口。验收出现具体缺口再作必要调整，不能删除图任务的绑定保护。

### B 的失败测试和回归边界

扩展 `task-graph-interactive-conversation`、`task-graph-conversation-delivery`，增加一个集中验证上述资格表的隔离套件。先让旧代码在“普通材料等待后需要只读中转/控制行才能继续”的场景失败，再验证同一 Inbox、job worktree、native session、原实施入口续接；Agent 回复及脚本不得含恢复控制行才能过关。

必须保留的反例：Writer alive/unknown、观察后 revision 或候选变化、其他 execution 材料、未授权输入、环境未就绪、验收中、scope/permission 暂停、exhausted、重复输入、领取后重启、Steering unknown/拒绝投递、历史 Followup 未收尾。分别验证不新增第二 Writer、不吞输入、不重做成功兄弟、不放行后继、不改变失败预算。

普通回答结束与正式交付分开断言：前者只保存回答/工作，不能仅因 native turn 完成就 delivered；后者仍需既有明确成果提交、固定候选和批准模式的检查/独立验收。没有结论的真实执行失败不伪装成正常问答。

回归 P0 timeout/reservation、Issue review 恢复、execution-progress、completed-workspaces、review-restart、卡片与历史材料用例。旧协议的测试继续存在，直至存量记录有明确迁移证据，不能为了新测试通过而删除。

## 最后一次真实端到端验收

使用专用隔离仓库、数据库、授权配置及一个新测试 Ticket 和一个后继；通过既有飞书路线确认卡获批后执行。不能选择 R05、M05 或 R6 等生产任务充当试验。

真实 Codex 在任务 worktree 编码；在真实绑定 Topic 中接收进度问题、补充材料、纠正判断；经历一次正常等待后自动回到实施；主动修复一个范围内检查缺陷；正式交付后由平台按批准模式独立验收并启动后继。人类消息来自真实用户或明确授权的测试身份，自动注入必须单独标记，不能伪装成原用户。

保留批准快照、Topic/message IDs、输入 receipt、native Session 身份、每轮 Writer/claim/revision、worktree/候选、资源摘要及预检回执、实际命令和原预算前后值。记录全过程没有新的只读中转、恢复控制行或并发可写 Writer；旧只读成果保护仍通过反例。

隔离回归与真实 Codex/飞书结果分别报告。真实链路未完成时明确标记未验收，不能用模型替身或源码静态检查代替。A、B 任一步完成不自动触发生产部署或恢复。
