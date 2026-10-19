# 检查和接续暂停的任务

在平台服务目录运行本地运维命令。默认只读，输出依赖、候选提交、原工作区、当前 TaskRun、实际写入者观察和处理动作。

```sh
npm run task-graph:doctor -- --run-id cmvdmf87w043f9xhgf9yvua6p --node-key M02
```

修复卡点、准备运行环境后，显式登记实施接续：

```sh
npm run task-graph:doctor -- --run-id cmvdmf87w043f9xhgf9yvua6p --node-key M02 --resume --request-id m02-platform-recovery-20261019-01
```

命令供有平台数据库访问权限的本机运维者使用，不能暴露成无认证的远程接口。它调用既有 `scheduleImplementationRecovery`，保留候选、原始基线、预算和退出检查。不重置预算，不删除目录，不重启服务，不伪造验收。

回执 `scheduled` 表示本次新受理，附账本事件 ID。`already_scheduled` 表示同一请求以前已受理，本次没有重新派发。如果后续再次暂停，应先处理新的卡点，再使用新请求标识。网络或客户端超时后的重试沿用原标识，避免重复执行。

`ready` 只表示排队。确认执行启动需要继续读取新的 TaskRun、实际原生进程及工具事件。没有退出证明或工作区归属异常时，恢复仍明确失败，不把任务强改为运行中。

## 2026-10-19 M02 诊断

旧写入者已经释放，但全进程扫描遇到同用户 SSH 进程的 `environ` 权限错误，于是返回 `unknown`。实际父链为 `2557519 → 2557418 → 3384943 → PID1`；独立 SSH 服务祖先出生早于图协调器，且不在协调器的祖先链中。

修复只在 `EACCES` 时尝试独立父链证明。核对当前 supervisor 的 PID 和出生时间，读取其全部祖先，再寻找候选进程的独立、早生、非 PID1 锚。两遍读取的 PID、出生时间及父 PID 都相同才排除候选。共同祖先、PID1 孤儿、父链缺失、身份变化和真实任务子进程继续阻止接管。

这个证明沿用运行器既有约定：nonce 只注入新启动的 harness，不注入预存在的服务器。它不防御恶意代码通过 IPC 向其他服务传递 nonce。

新 writer 创建时保存完整祖先身份。owner 仍活时，当前链必须与保存链一致；owner 已退出时，仅允许使用经验证保存的链替代已经消失的 owner 链，仍重扫全部 nonce 候选。历史共同祖先继续拒绝，存活历史祖先身份变化也拒绝。没有保存链的旧 writer 在 owner 消失后仍可能返回未知。

本次首次空闲加载后，M02 又触发了旧 owner 已消失的边界，恢复被拒绝，没有产生新派发。M02、R05 的旧身份迁移使用本轮独立复核在加载前实际读取的完整链，来源为 `/root/recovery_boundary_review` 的工具输出 `chunk38cb7f`，事后归档并明确标注。迁移核对原 supervisor 确实不存在、boot/host/uid、两个 writer nonce、匹配 release、当前 claim/revision/candidate 及存活祖先身份，追加 `operator_writer_ancestry_migrated` 事件。它只补身份数据，不改变状态、预算或候选，也不把先前 `exited` 布尔值当作免扫描许可。

回归入口：

```sh
npm run test:task-graph-postgres -- task-graph-process-lineage task-graph-writer-ownership task-graph-lifecycle-adapters task-graph-restart-recovery task-graph-implementation-recovery task-graph-failure-summary
```

使用独立 PostgreSQL schema。真实 nonce 子、不可读真实子、共同祖先、孤儿、断链、PID 重用及再次暂停后重复旧请求均有反例检查。独立复核由 `/root/recovery_boundary_review` 完成，精确模型未记录。

M02 的现有浏览器已复制进该 job 的 ignored `scratch/platform-browser-*`，沙箱预检实际读取 `m02-runtime-ready` 页面。该预检证明当前目录内浏览器可用，不代表 M02 的真实识读或双视口业务验收通过。Reader 固定交付的控制器与样本证据仍由实施者核对；确有缺项时要指出具体字段、来源和补救措施。

## 本次实际恢复回执

2026-10-19 16:42（北京时间），M02 新 TaskRun `cmvf08jxm003jy3p1sxazgobe` 已进入 `running`，原生进程 `4154075` 存活，已记录 12 次工具调用。仍使用原话题的同一张进度卡（distinctCards = 1），候选提交 `bdfe97ac8cf02669f4467d267f1f701b77c67793` 保留。16:44 再次只读检查仍为 running，写入者 alive。

同一 request-id 重复请求实际返回 `already_scheduled`，没有重复派发。此次实际接续已完成，不必再运行上面的恢复示例。运行回执见 `docs/evidence/task-recovery-doctor/m02-live-final.json`，加载回执见 `service-load-02.json`，幂等回执见 `m02-repeat-receipt.json`。

这些证据证明 M02 已恢复执行，尚未证明业务验收通过。R05 本轮未接续，也尚未证明两仓实际同时运行。当前任务运行期间不再重启服务。

## 一次检查整条获批路线

省略 `--node-key`，读取完整 Run：

```sh
npm run task-graph:doctor -- --run-id cmvdmf87w043f9xhgf9yvua6p
```

Run 模式只读，不允许 `--resume`。命令在数据库 `REPEATABLE READ`、`READ ONLY` 事务中读取图、当前 progress、TaskRun、确认提议和每个节点的最近事件。写入者进程在事务后采样，报告给出采样起止时间。两者不构成原子快照；单个写入者探针失败不会中断整图诊断。

每个节点和执行都有分类、负责人、下一步、当前阶段、候选提交、相关重试计数和状态转移位置：

| 分类 | 平台下一步 |
| --- | --- |
| `waiting_dependencies` | 等待列出的前置完成，不作为自身失败 |
| `eligible` | 派发候选，核查协调器领取条件，不代表已启动 |
| `platform_recoverable` | 核验环境或前置绑定准备，沿原预算处理 |
| `code_defect` | 交原实施者有限回修 |
| `business_material` | 核验执行者的缺项陈述，列出材料、来源和责任方 |
| `writer_unknown` | 保留现场，报告无法安全接管的身份依据 |
| `budget_exhausted` | 运维制定新措施，不盲目重置预算 |
| `completed`、`running`、`review` | 区分已验收、实际写入者存活与复核阶段 |
| `decision`、`diagnostic_error` | 明确决定要求或诊断数据错误 |

`progress.lastFailure` 是当前账本保留的报告，不是经过独立核实的材料缺失事实。已恢复执行不再按历史故障分类。当前冻结依赖与执行派发字段另行比对快照；快照 hash 相同不等于物化执行行没有变化。

`automaticProgress.status` 使用 `verified`、`not_verified`、`stalled`。当前只读实现不会把依赖完成、`ready` 或写入者存活当作“所有条件满足且无需人工自动推进”的证明。环境、材料、恢复授权、实时 Issue 版本和协调器内存容量仍为未知；报告明确保留这些未验证条件。

若当前执行停在 `attention/waiting_decision`，报告标明 `applyExecutionOutcomeTx` 到 `runTaskGraphCycle` 的断点。协调器只自动派发 `ready` 或恢复失去写入者的 `claimed`，不会自动消费此暂停；恢复入口是显式 `scheduleImplementationRecovery` 或专用回修处理器。诊断暴露这个缺口，不通过改状态掩盖它。

回归验证命令：

```sh
npm run test:task-graph-postgres -- task-graph-run-doctor
```

测试使用独立 PostgreSQL schema。它覆盖等待依赖、暂停断点、历史故障不污染已恢复执行、无关预算不阻断、写入者未知、部分探针失败、快照漂移和诊断前后账本不变，并验证数据库拒绝只读事务中的写操作。本命令不修复 Reader 包、执行环境或自动恢复机制，也不证明业务验收完成。

### 最新整图采样取代此前启动回执

2026-10-19 的整图只读采样记录在 [initial-live-summary.json](../evidence/run-doctor/initial-live-summary.json)，具体 UTC 时间见 `databaseSampledAt`。24 个节点中，6 个完成、16 个等待依赖，当前可推进前沿是 M02 和 R05。M02 分类为平台前置绑定待核验；R05 分类为材料缺项待核验，该分类仅反映执行者陈述，不证明批准来源里确实没有材料。两个暂停执行均明确输出了自动状态转移断点。

上文 16:42 的运行回执只证明当时启动成功。最新采样中 M02 的实施 TaskRun 已结束，但节点再次暂停，未通过业务验收。因此不能用旧的 `running` 回执宣称目前仍在推进。诊断仅报告已观察事实，本次未恢复任何节点、改动预算或重启服务。
