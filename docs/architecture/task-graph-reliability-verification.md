# 任务图可靠性修复验证记录

## 当前范围

本轮对应 Gitee 父单 [IKNBDN](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDN) 下的 WR01–WR07，修复基线为 `e7c584e`。用户已授权直接实施。本文记录本地实现与验证，不将本地通过解释为运行服务已更新，也不将平台测试解释为 Reader 业务验收通过。

平台故障重试上限为同一执行轮次累计两次，实施准备、架构复核和验收共同使用，不在集成或普通继续时清零。代码回修上限为两次，格式补收一次，集成引用推进最多三次。

真实合并冲突保留双方 SHA、路径和 MERGE_HEAD。当前审批不含可证明的逐路径冲突处理授权，因此不会仅凭双方都属于任务图就自动解决冲突，必须给出具体决定。

继续使用现有依赖图、工作区、提交与独立验收机制。修复将可恢复失败交回现有协调器自动领取，并保留有限预算；真实权限、范围或归属问题保留明确决定点。

## 生命周期入口迁移

| 入口 | 当前职责与边界 |
| --- | --- |
| `applyExecutionOutcome` / `applyExecutionOutcomeTx` | 版本化进度的阶段、候选提交、预算和下一状态；按 claimToken、revision 及幂等键拒绝旧写入。 |
| `recordExecutionIssue` | 有版本进度时转发统一 outcome；无版本记录保留兼容路径。 |
| `pauseGraphImplementation` | 当前候选先保存；环境失败有限自动重试，真实决定单独分类。历史无版本事件仅作兼容。 |
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
