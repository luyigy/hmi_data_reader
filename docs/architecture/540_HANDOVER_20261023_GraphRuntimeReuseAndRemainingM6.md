---
doc_type: HANDOVER
doc_status: in_progress
next_action: none
plan: null
slice: null
plan_progress: in_progress
---

# Graph 环境复用与剩余 M6 真实链路交接

本文件按用户明确要求为更换 Session 保存上下文，不驱动旧 watcher，不启动新路线。业务 Graph 没有因交接而暂停。状态核实时间：2026-10-23 13:27:49，后续 Session 必须重新只读查询。

## 先读与先做

1. 读取 AGENTS.md、最新提交、本文，再读实际源码。不要从最早的 536 进度重新开始。
2. 只读核对下列运行中 TaskRun、节点、Writer 和部署 PID。不要重复触发正在执行的票。
3. 优先跟踪 R6_NISSEI、M6_ARBURG、M6_YIZUMI，到 M6_NISSEI 和 M07 自动接棒。用户要看真实票，不能用另建演示替代。
4. 日精取图用户已经授权，不再重复询问。核实该授权是否实际装配进 Sandbox；当前活动 Writer 不能被中途换权限或重建环境。
5. 新缺陷先在隔离工作树建立红色回归，再做最小修复。不要把工作区池整体重构扩大进本轮。

## 用户确认的架构方向

- 获批 Ticket 是持续 Coding Agent 会话。平台负责调度、权限隔离、Git 集成、成果交接；Agent 自主编码、测试、修复和交付判断。配置了 Tester 才由 Tester 独立验证。
- Matt/pstack 技能提供工程方法，平台不额外制定业务质量门禁。
- Candidate Commit 是代码快照，合法 delivered 是正式交付，两者绑定最新 Worktree 内容。
- 回执格式错误回到原 Native Session，保留正常 Implementor 写权限。相同候选、输入和错误最多自动纠正两次，有实质进展不能按累计次数卡住。
- Graph 资源按仓库、版本准备和复用。已有虚拟环境、固定技能包只读挂载，不要每票复制或安装。必要的权限、摘要与完整性检查保留。
- 串行票可复用同一物理目录和槽位工作分支；每票使用不同 Session，交付 SHA 留档。真正并行才额外分配工作区。
- 每票保留给后续 Session 参考的交接材料，复用旧 workflow contract 的文档部分；Graph 继续负责调度，不重新启用 watcher。
- 保留单 Writer、claim/revision、Git CAS、W001、Sandbox 和既有权限边界。不新增调度器、状态机、wake source 或项目特判。

## 已提交、推送的修复与实际部署

分支 oss-prep，最近三个提交均已推送 Gitee、luyigy；本轮交接前工作区只有两项用户未跟踪内容。

| 提交 | 已实现范围 | 验证与限制 |
| --- | --- | --- |
| c3659d8 | HTML v2 说明 Graph 资源、串行目录/分支复用和每票交接方向 | 设计文档，不表示工作区池已经实现 |
| 429e8af | Graph 内成功技能/浏览器探针复用；部署版本进入既有条件指纹，允许条件变化后的自然续接 | 真实 Bubblewrap/Chromium 并发复用与篡改拒绝回归通过；FANUC 真实验收通过 |
| 1ca6143 | 已完成且已收尾的只读问答不再永久占用续接；Agent 提示分别写清实际候选、工作区基线、集成参考 | 红绿回归、类型检查、长文件、W001 和 admission 保护通过；新服务已启动，三票正在执行 |

429e8af 的资源复用缓存放在现有 TaskGraphEvent，kind=runtime_probes_verified；失败不缓存。按 run、repo、policy、Python、资源及探针身份区分，使用数据库 advisory lock 串行首轮探针。项目自身探针还绑定源码身份。并未省略资源完整哈希检查。

1ca6143 的完成问答放行仍要求对应 TaskRun 终态、同一节点和 reservation 的收尾记录、Writer 退出证明。活动 Writer 和真实用户决策仍会阻止错误续接。

旧调度 Node 710431 在 YIZUMI 当前工作自然结束后退出。13:25:37 新 Node **885249** 启动，用户服务 MainPID **884931**。因此此前“等待换版”的记录已过时。新服务路径 scripts/task-graph-runner.ts，工作树 HEAD=1ca6143。不要为交接再次重启服务。

## 当前真实任务状态

Graph run：`cmvdmf87w043f9xhgf9yvua6p`。

| 节点 | 13:27:49 状态 | 本轮 TaskRun / 备注 |
| --- | --- | --- |
| M6_FANUC | passed | 12:53:43 通过，交付 b3d0dedc426077b362762809c7e008c7edb477fa，独立验收 cmvkhosx000ovbhsqiyns6yfg；不要重跑 |
| M6_ARBURG | claimed / implement / active | cmvkj1fdm004db924qfccefzp，13:26:05 启动；原候选 2a3bf035，与集成参考不同是合法情况 |
| M6_YIZUMI | claimed / implement / active | cmvkj1gow004tb924ftsryr6p，13:26:07 启动；正在修复平台真实检查失败 |
| R6_NISSEI | claimed / implement / active | cmvkj1af40021b924ipavowvg，13:25:58 启动；13:27:47 仍有实际资料查询事件 |
| M6_NISSEI | planned | 等 R6_NISSEI 等前置，不应强行跳过 |
| M07 | planned | 六品牌证据目录与旧页迁移/缺口汇总，等待全部六个 M6 通过 |

M07 的 M6 前置中 DEMAG、BOLE、FANUC 已通过，其余继续追踪。M6_NISSEI 和 M07 已提前绑定现有获批 mold 资源范围，尚未执行不等于部署失败。

YIZUMI 上轮 cmvkidc7a0is6bhsqt1w4ayf5 于 13:24:02 返回 delivered，Agent 报告 24 项通过。但平台重新执行冻结 pytest 得到 **23 passed / 1 failed**。具体错误：backend/tests/m6_yizumi_browser.py:43 要求当前受管输出 frontend-dist/index.html，平台测试该轮输出未存在。新一轮已自动回到实施者，repairAttempts=1。这是实际测试/产物问题，不能据 Agent 回执将票写成通过，也不要直接改冻结检查或手工补账本。

## 日精“已允许取图但没动静”的最新核实

用户确实在日精任务话题回复：**允许从hmi-finetuning取图验证**。

- 时间：2026-10-23 13:22:46.135。
- 持久消息：Message `cmvkix5o60h6ows042w4jgwuv`，roomId `cmvgg058n1g0v78k1hxsaz897`，userId=task-room-user。
- 本私聊用户再次说明已授权的 LiveRoomMessage：`cmvkizq7c0haiws044bpaihb3`。
- 新服务启动后 R6_NISSEI 已于 13:25:58 自动恢复。13:27 时 project_material_query 持续查询 training 中日精资料，cursor 已推进到 2040。因此不是仍被旧 conversation_writer_reserved 卡住。
- **授权事实与资源装配要分开核查**：当前事件的 policyHash 仍是 `fac64640a6bcab5ba8acf7c1aeb66400d18409ab0e5eb9be68eadc78d969a31c`，旧策略未包含 `/data1/code/hmi_finetuning/datasets`。目前不能声称本地原图目录已经对 Agent 可读。
- 本轮没有更改全局权限文件，也没有在活动 Writer 下切换资源。下一 Session 如发现本地目录仍不可读，应沿现有官方 capability 升级入口兑现已获授权的最小只读取图范围；不必再次向用户索取同一授权，不扩大为代码执行或数据写入权限。
- 原技术缺口是独立 TACT5 保留图/ground truth 与训练分组，历史若干 output 路径现已不存在。允许读目录不保证必然找到独立原图；要核实真实来源与独立性，不能拿训练图冒充验收图。

## 精确定位与下一步入口

| 节点 | nodeId | executionId |
| --- | --- | --- |
| R6_NISSEI | cmvdmf880044o9xhgcd3rn6qb | cmvdmf880044p9xhg6z3mtzlv |
| M6_ARBURG | cmvdmf87z043w9xhgp6qkzrf0 | cmvdmf87z043x9xhg4ge3392q |
| M6_YIZUMI | cmvdmf87z04469xhgptatgypv | cmvdmf87z04479xhgsg531lko |
| M6_NISSEI | cmvdmf87z04449xhgokadsbv2 | cmvdmf87z04459xhgb6sft4g5 |
| M07 | cmvdmf87z043u9xhgips1oo26 | cmvdmf87z043v9xhgw3kai2u3 |

业务子任务 ID 为 task-graph-<executionId>。业务仓库 mold-data-webpage-tool、hmi_data_reader。不要混淆 M6_NISSEI 与 R6_NISSEI。

管理员策略：`/home/hello/.agent-platform/project-capabilities.json`。

官方能力升级：`npm run project-capabilities:scope -- --execution-id=<id> --prepare-runtime-upgrade` 先预览，再依据新鲜 policyHash apply。源码 `src/lib/project-capabilities/legacy-scope.ts`，函数 migrateLegacyProjectScope。Reader 的待用 preview 只是预览，不能盲目覆盖当前全局策略。应用前核对最新文件、claim、Writer 与候选，保留其他项目条目。

续接统一入口：`src/lib/task-graph/implementation-result.ts` 的 scheduleImplementationRecovery。重试复用持久请求 ID 并核对现有 receipt。不要盲跑 output 内旧脚本，它们记录了当时的授权与状态。

核心源码：runtime-probes.ts、runtime-preflight.ts、runtime-continuity.ts、preparation-recovery.ts、coordinator.ts。先看 git show 429e8af 和 git show 1ca6143，再查实际调用路径。

## 证据、隔离环境与检查

- 最新只读全量快照：`output/reviews/remaining-m6-20261023/handover-current.json`。可读脚本 handover-inspect.cjs；查询使用 READ ONLY 事务。output 文件未提交，留在本机。
- 同目录包含各票 scope 预览/应用结果、续接 receipt、Reader 未应用 preview、两组红绿日志。旧 result.json 中“等待换版/授权待确认”已被本文的新状态替代。
- `output/reviews/m6-runtime-reuse-20261023/` 保存 FANUC 真实通过与资源复用证据。
- `docs/architecture/show-me-graph-runtime-reuse-20261023.html` 是已发给当前私聊的 v2 方案。工作区池、共用槽位分支及每票交接 runtime 接线还未实现。
- 隔离工作树 `/data1/code/agent-platform-v2-runtime-reuse` 对应 429e8af；`/data1/code/agent-platform-v2-conversation-release` 对应 1ca6143。不要删除业务或用户工作树。
- 回归：`node scripts/test-task-graph-postgres.mjs task-graph-admission task-graph-approved-continuation`；另一组 task-graph-result-recollection、task-graph-natural-blockers。运行器创建隔离数据库 schema，禁止向 public 执行 db push。
- 429e8af 还通过 runtime-reuse、runtime-pinning、condition-recheck、review-platform-retry。1ca6143 通过类型检查、长文件、W001 与 admission 保护。并发 admission fixture 曾瞬时失败一次，增加失败诊断后两次通过；未放宽保护。
- 交接本轮只写文档和只读检查，不改平台源码、不重启、不改账本。check:long-files 通过。

## 必须保留和沟通约束

- 用户未跟踪内容 `docs/architecture/526_agent-platform-v2 极简架构重设计方案md`、`skills/architecture-house-tour/` 不动。
- Git 历史只追加，禁止 amend、rebase、reset 或强推。
- 不把 M6_FANUC 的成功推广成所有 M6 / M07 已成功，不把探针复用说成完整工作区池已完成。
- 用户看不到本地链接。文档、HTML 应通过平台 Bot 发到当前私聊，不能只给本地路径。
- 私聊 chatId `oc_b634823504e29e6220de0cfb5108a216`，Bot CLI 配置 `/home/hello/.lark-local-ai`。读取 lark-im/lark-shared 技能后使用独立配置发送附件并回读确认归属。
- 不重启承载当前会话的 Feishu 服务；不因换 Session 中断业务 Writer。当前交接不发送 graph-control。

本次尚未做的事情：完整串行工作区/分支池、每票交接文档的运行时接线；剩余 M6 与 M07 的真实验收闭环；日精本地取图权限装配的最终核实。这些不能写成已经完成。
