# 任务图可靠性修复验证记录

## 当前范围

本轮对应 Gitee 父单 [IKNBDN](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDN) 下的 WR01–WR07，修复基线为 `e7c584e`。用户已授权直接实施。本文记录本地实现与验证，不将本地通过解释为运行服务已更新，也不将平台测试解释为 Reader 业务验收通过。

平台故障重试上限为同一执行轮次累计两次，实施准备、架构复核和验收共同使用，不在集成或普通继续时清零。代码回修上限为两次，格式补收一次，集成引用推进最多三次。

真实合并冲突保留双方 SHA、路径和 MERGE_HEAD。仅当原票已批准该仓写入、双方提交有完整的本 Run 交付来源、冲突是双方都修改的普通文本，且不超出原票限制时，允许一次受预算约束的冲突回修。Agent 只能写解决产物，由平台核对路径、提交身份和工作区指纹后完成合并，并重跑合并结果检查及独立验收。未知来源、范围变化或目录归属异常保留现场并说明具体处理动作，不能仅凭同属一个 Run 放行。

继续使用现有依赖图、工作区、提交与独立验收机制。修复将可恢复失败交回现有协调器自动领取，并保留有限预算；真实权限、范围或归属问题保留明确决定点。

## 生命周期入口迁移

| 入口 | 当前职责与边界 |
| --- | --- |
| `applyExecutionOutcome` / `applyExecutionOutcomeTx` | 版本化进度的阶段、候选提交、预算和下一状态；按 claimToken、revision 及幂等键拒绝旧写入。 |
| `recordExecutionIssue` | 有版本进度时转发统一 outcome；无版本记录保留兼容路径。 |
| `pauseGraphImplementation` | 当前候选先保存；明确暂时故障有限自动重试，缺能力及未分类环境故障交给平台准备，真实决定单独分类。历史无版本事件仅作兼容。 |
| `scheduleImplementationRecovery` | 显式授权后转 `operator_resume`，保留候选与预算。普通继续不能放行归属异常或重置耗尽预算。 |
| `scheduleGraphRepair` | 依据稳定检查 ID 和受影响 executionIds，仅重新派发失败执行。成功兄弟的提交与证据保留，联合验收重跑。 |
| `submitNodeVerification` | 在当前复核归属下发布节点证据；结论补收耗尽不能合成通过。 |
| `recoverTaskGraphNodeVerification` | 显式验收恢复入口；不得借恢复重置预算或绕过归属核对。 |
| 重启回收 | 使用实际进程身份和当前阶段记录，确认旧写入者退出后才重新领取。时间、内存列表和数据库完成状态不能单独证明退出。 |
| `flagStaleExecutionClaim` | 仅兼容旧无版本记录；有版本记录必须走带写入者证明的恢复流程。 |
| `reclassifyIncompleteDelivery` | 管理员、审批快照、原交付身份及后继状态核对后，追加授权事件并转统一 `delivery_reclassified`；原集成提交与证据保留。 |
| `adoptLegacyExecutionProgress` | 单次受控迁移；先验证登记工作区、分支、原始基线及候选祖先关系，记录最新候选，不自动启动业务。 |
| 路线审批、人工验收、依赖放行 | 保留节点级职责，不可替代 execution 的实际交付、集成和验收证据。 |
| 通知与进度卡 | 独立投递记录，不推进业务状态。按任务话题复用一张卡，旧 TaskRun 不覆盖新进度。 |

新版本执行的恢复阶段和候选来自当前进度。旧事件用于审计以及尚未迁移记录的兼容，不参与版本化记录的当前事实推断。

## 已完成的隔离验证

以下测试使用新建的 `task_graph_test_*` PostgreSQL schema、临时 Git 仓库与受控进程。出站飞书调用由测试替身接收，没有对真实任务执行恢复或发送消息。

- `task-graph-auto-completion`：首次检查失败后自动回修，后继自动启动，独立支线推进，人工 resume 次数为零。
- `task-graph-output-runtime` / `output-lifecycle`：实施、自测及验收能够写报告，保护输入、原仓和历史材料保持不变；大文件保护输入不计入输出复制限额。
- `task-graph-integration-retry`：引用推进后对最新合并结果重检并 CAS 更新；真实冲突保留现场；次数有限。
- `task-graph-execution-progress`：旧 revision 与 claimToken 拒绝、重复 outcome 不重复计费、候选与集成提交分离、耗尽不能普通继续。
- `task-graph-lifecycle-adapters`：旧完成入口不能绕过阶段；授权恢复及交付重分类保留候选、集成证据和预算；时间回收不能绕过进程证明。
- `task-graph-card-closure`：首次派发前卡片与 TaskRun 共用卡片；投递不确定时保留原 UUID 与时间；旧轮次不挤占轮询；失败原因保留在卡片详情。

完整回归、独立评审和真实 R01 接续的最终结果另行追加，尚未通过的项目不得勾选为完成。

## 原现场保护与部署边界

实际 R01 当前候选为 `0d91d8931fc44bfb17254feb6ae747f82e7e3bdb`，历史阻塞点为 `f0f4b05d6b48fbe9c40bae8b3608aebe730f215a`。读取现场不等于已恢复。部署前仍须再次核对真实进程、当前提交和工作区内容。

原图及 `input-materials`、项目原仓和既有 `.venv` 不进入清理候选。清理只针对登记归属于平台、且无活跃使用者的受管资源，不依据文件名是否带 `tmp` 判断。合并冲突、脏文件或归属不明时保留现场，不执行 reset、stash 或自动删除。

独立评审完成后才统一更新运行服务。真实 R01 必须按原批准模式通过原要求；不放宽业务指标，不用模拟数据证明实际后继运行。

## 2026-10-18 21:41 实施结果

- `npm run test:task-graph-postgres` 退出码 0，完整 50 套测试通过。另在合并后的代码上运行启动失败单例，确认自动重试与后继启动，人工 resume 为零。
- `npx tsc --noEmit --incremental false`、`npm run check:long-files` 和 `git diff --check` 通过。
- 独立评审使用 gpt-6-sol @high，最终结论无剩余具体阻断问题。先前还使用 gpt-6-astra 和 gpt-6-luna。可用评审模型均属 GPT-6 系列，不能视为跨模型家族验证。
- 部署代码 `ab1764d` 已发布到 [修复分支](https://gitee.com/luyi1678/agent-platform-v2/tree/fix/workflow-reliability-20261018)。协调器和进度卡服务于 21:39 统一重启一次，MainPID 分别为 4046945 和 4047172。重启前没有被领取的任务图执行。
- 主飞书服务没有中断当前会话，已登记一次延后重载。必须确认当前会话 TaskRun 结束且原生进程退出后才执行；不会顺带重启正在实施的任务图服务。
- R01 原候选 `0d91d8931f` 保留，仅增加输出声明提交 `c7b74e9054`。已核对旧原生进程 3327097 退出，原工作区干净；迁移审计与原审批保留。原图 SHA256 为 `03830ab484fc905a35947a0094e1d682c8287e1d397fe520d91f523ef6104962`，保护输入未修改。
- 真实新 TaskRun `cmvdvh93b004g10x0n0lwhezy` 已进入 running，原生进程 4050836 存活，正在执行项目测试。此处不宣称 R01 已验收通过或后继已启动。

本地原始记录位于 `output/reviews/workflow-reliability-20261018/implementation/`，包括 `full-regression-final.log`、`startup-merged-green.log`、`final-typecheck.log`、`r01-controlled-resume.json` 和 `r01-progress.json`。提交的决策记录见 [decisions.tsv](../evidence/workflow-reliability/decisions.tsv)。

## 2026-10-18 22:03 真实接续与补充修复

R01 已通过平台检查与独立业务验收，独立验收 TaskRun 为 `cmvdvm9mh011010x0rxroyh9j`。实际后继 M01、R02、R04 随后自动派发。本轮没有用模拟数据或放宽业务指标证明后继启动，也不代表其余品牌和 Model 保存回读已经完成。

后继暴露两项原回归遗漏，均已增加真实回归并修复：

- `bb2088b` 修复新 worktree 继承输出声明时，对不存在的受保护原图路径强制 `realpath` 的 ENOENT。只跳过确实不存在的路径；已有原图保持只读，不创建假材料目录，不吞权限或软链错误。
- `139bf8c` 修复 extra repo 权限误删前置固定交付绑定。M01 原输入清单为空，误读 Reader 原仓旧合同；现在固定清单包含已验收 R01 提交 `c7b74e905401356878e355a60b6afba64d2ae835`、固定源码、项目环境及归档证据。原仓权限和固定交付各有用途，原仓 HEAD 与未提交文件不被修改。

中途使用的临时协调器未加载正式服务的网络环境，导致 R02、R04 原生启动失败。该路径已停止，失败记录保留。22:02 在确认无任务图写入者后，仅重启正式协调器加载修复，MainPID 为 `4148918`，然后由恢复接口将三项置为 ready，由正式服务领取；恢复脚本不再自行启动执行器。

22:03 已核对三项实际原生进程存活且有工具调用：M01 `4152185`、R02 `4150688`、R04 `4151128`。M01 新输入清单 hash 为 `badc88e2ae541e46940e17b783427fa49ff9a493cdc5603acacc620aa32059c7`，包含 R01 固定提交和实施及验收归档。此处仅证明真实接续，三项业务结果仍在执行。

合并后新 extra repo 回归、现有 extra repo 回归、upstream inputs 回归、TypeScript、长文件检查及 diff 检查通过；独立评审 gpt-6-sol @high 批准 `139bf8c`。原 50 套全量通过的记录仍有效，但发生在这两项追加修复之前；追加修复运行了对应受影响测试，没有冒称重新跑过全部 51 套。

原始追加证据为 `inherited-outputs-green.log`、`extra-upstream-merged-green.log`、`extra-upstream-typecheck.log`、`recover-normal-frontier.log`、`frontier-live-proof.json`、`m01-fixed-input-proof.json`。主飞书服务仍等待本会话实际退出后重载一次，不中断当前连接。

追加审计回执见 [live-recovery-receipts.json](../evidence/workflow-reliability/live-recovery-receipts.json)，包含独立验收原始结论、三项后继实际进程、固定输入、服务启动时间、TypeScript 退出码及 tracker 状态。临时进程的网络超时和 routing 失败是直接记录；环境差异是依据启动方式推断，未取得进程环境逐项比对，不把推断当成额外实测。WR01 已关闭，WR07 与父单仍开启观察。

## 2026-10-18 22:12 会话结束误报修复

用户报告三项均显示会话结束。现场核对发现，飞书主服务于 22:06 重载时，旧启动清理将所有 running TaskRun 统一置为 completed，不区分独立协调器持有的任务。三项错误完成时间完全相同，但原生进程和工具调用一直持续，未出现真正的结束事件。本次没有恢复任务或创建新 attempt。

已在核对实际写入者、原生进程存活且无真实终结事件后，以原 completedAt 和元数据 CAS 修正三项 TaskRun 与参与者的显示状态，并追加 `task_run_display_reconciled` 审计。22:12 三项原生进程仍存活、工具调用继续，卡片投递记录也已回到 running。

`b4dee81` 将旧清理提取为 `cleanupFeishuOwnedStaleTaskRuns`。飞书启动不得修改任务图所属 TaskRun 或参与者，不论其写入者是否已退出；由任务图协调器负责恢复。规则同时识别 graphWriter、graphReview、旧执行绑定和复核任务。其余已知原生进程仍存活的会话也保留，仅处理无所属且无已知活跃进程的历史会话。

新增真实隔离 PostgreSQL 回归复现旧行为，并验证新行为及重复清理。合并后该回归、TypeScript、长文件及 diff 检查通过，独立评审 gpt-6-sol @high 批准。未重新运行全量套件，不宣称三项已完成业务验收。

主飞书进程尚未加载本次源码，已登记 `ap-feishu-startup-fix-idle-20261018.service`，等待当前会话 TaskRun `cmvdwhylh000blysqb3fjl4g6` 与原生进程退出后，仅重载主飞书一次。任务图协调器及执行进程保持运行。回执见 [startup-cleanup-verification.json](../evidence/workflow-reliability/startup-cleanup-verification.json)。

## 2026-10-19 冲突接续与运行资源修复

本轮修复基线为 `997ab3d`。用户要求先核对是否仍有执行者，再实施诊断所得问题；开工前及 00:04 的账本、实际写入者检查均确认 R02、M04T 旧执行者已退出，没有活动任务图 TaskRun。未使用普通继续清除冲突或重置预算。

### 实施边界

- 旧冲突先验证原仓写入授权、同 Run 完整提交来源和当前 MERGE_HEAD，再进入已有回修状态。Agent 读取只读冲突源码并输出 `resolution.json`；平台按实际 TaskRun 的输出事件定位产物，检查文件集合、指纹和父提交后完成合并。未知执行者保持等待，后续出现退出证明时重新核对。
- 合并仍使用最新已批准集成提交并重跑检查、架构复核及独立验收。冲突期间不执行 abort、reset、stash，不删除或覆盖原仓现场。
- `claimed` 节点的全部 execution 已集成时，调度器自动推进验收；不重复启动原实施 Agent。
- 缺少运行能力与暂时故障分别处理。前者显示明确的平台准备动作，后者保留既有有限重试预算。新声明不授予目录权限，不安装依赖。
- 归档读取保留原输出事件身份，并验证完整文件树、摘要及目录归属。历史事件没有原始文件摘要的部分，不能声称具有更强的历史字节绑定保证。大归档每次冷读取需要校验字节，本轮没有性能测量结论。
- 卡片和异常进度说明显示具体文件、处理方与下一步；技术问题不再直接显示空泛的用户决定。原始错误保留在技术详情。

### 已验证的隔离场景

`task-graph-conflict-repair`、`conflict-continuation`、`integrated-restart`、`environment-outcome`、`prior-output-archive` 和 `failure-summary` 在合并源码上通过。测试使用一次性 Git 仓库、独立 PostgreSQL schema 和受控进程；其中重启测试实际终止协调器子进程，没有调用人工 resume。

独立运行 `AP_RUNTIME_TEST_CHROMIUM_EXECUTABLE=/opt/google/chrome/chrome npm run test:task-graph-runtime-integration`，真实 Chromium 147.0.7727.137 在 Bubblewrap 中启动并读取本地页面。配置未提交修改、暂存删除、越权资源、摘要不匹配及 OCR 归档迁移均有覆盖。此环境测试不证明业务仓已获得运行资源：Reader 与 Model 当前未添加版本化运行声明。

预检目前覆盖原生实施、逐仓平台检查及架构复核选定的工作区。独立验收 Agent 使用非 Git 运行目录，不读取被验收源码仓的声明；本轮不声称多仓资源声明已经合成，或所有复核阶段都已具备预检。

### 最终验证与加载回执

- 已登记的 58 套回归累计通过：首次从头运行通过前 11 套；修正卡片后通过后续 24 套；修正无声明空仓兼容后，从失败处继续的最后 23 套退出码为 0。失败日志保留，没有将这些结果冒称为一次完整命令退出码 0。冲突修复期间 extra repo 只读的追加修改，另在合并源码上重跑相关 4 套测试通过。
- 本轮回归实际补出并修正了三类遗漏：明确的瞬态数据库/网络启动错误丢失原因；耗尽预算后仍显示待回修；可选资源预检错误拒绝尚无首个提交的仓库。卡片的旧断言改为明确区分技术处理与业务决定；没有放宽业务验收条件。
- 合并源码的 TypeScript、长文件检查、diff 检查及真实浏览器预检均通过。独立评审为 gpt-6-sol @high，无剩余具体阻断；评审模型均属于 GPT-6 家族，不声称跨模型家族验证。
- 00:30 在再次核对任务图无活动执行和验收后，仅加载协调器及进度卡服务一次，代码为 `e39ae78`。MainPID 分别从 4148918、4047172 变为 666364、666657。主飞书服务始终为 21469，当前聊天未重启。
- 空闲核对中，历史 S06 缺少新版 writer 身份。只对其精确 execution/TaskRun 核对单一 local Codex 参与者、真实结束事件、记录 PID 2367517 不存在及进程组为空，保留一次性只读证明后加载。没有迁移、恢复或修改旧 S06 状态，其他未知执行者仍阻止加载。
- 00:32 的实际接续回执：R02 TaskRun `cmve1ksr60026b0j3vouqy2zw`、原生 PID 669268；M04T TaskRun `cmve1kuia0038b0j30rp6hjbf`、原生 PID 670464。两者处于 running，已有 19、16 次工具调用。由协调器自动领取，未调用人工 resume；每个仓库绑定的投递记录只使用一张原卡，状态为 running。
- 同期核对 Reader、Model 原仓的 HEAD、未提交 diff 摘要及未跟踪文件摘要，与 00:10 的记录完全一致。此处是该时点的字节摘要证明，不代替后续执行的持续观察。

上述接续只证明真实回修已经运行，不代表 R02/M04T 已合并或通过独立业务验收，也不代表 24 节点路线已完成。WR04、WR06、WR07 和父单继续保留业务观察；无声明的资源预检、独立验收资源绑定等边界见 [运行资源声明](task-graph-runtime-resources.md)。

结构化回执：[workflow-repair-20261019.json](../evidence/workflow-reliability/workflow-repair-20261019.json)。原始日志保留在 `output/reviews/workflow-repair-20261018-2338/`。

### 00:35 真实合流进展

R02 已自动集成为 `cd92faeb2cfb86486fc9b65d2053e50a31fede2f`，节点进入 `verifying`、阶段为 `acceptance`。直接核对该提交同时以原 R02 候选 `29b0b7f` 和最新 R04 交付 `d0b2fdb` 为祖先，合同保留 R02、R04 及 `0.4.1` 内容。此证据补充了前面的真实启动记录，仍不表示独立验收已通过。M04T 同期仍在受控回修，未重复恢复或重启服务。
