# S01 两项可靠性失败的隔离诊断

日期：2026-10-20。基线 `d532c5e`，分支 `fix/s01-reliability`，worktree `/data1/code/agent-platform-s01-reliability`。

本轮按用户要求定位失败并定稿 S02 合同。没有部署修复、修改生产任务、发布 tracker 内容、重启服务或恢复业务节点。最终差异不含 `src/`。保留原主仓未提交材料。

## 隔离和结果

每条 PostgreSQL 命令都由 `scripts/test-task-graph-postgres.mjs` 在已校验的本机服务新建唯一 `task_graph_test_*` schema，结束时删除。没有向 public 执行 schema push。Issue 和飞书外发保持夹具 stub；Git、沙箱和数据库路径使用真实实现。进程检查延迟和 worker 释放时刻是测试内故障注入。

| 命令或对照 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:task-graph-postgres -- task-graph-interactive-conversation` | exit 0 | 原测试本次自然运行通过，不能据此否定历史 P2028 |
| `npm run test:task-graph-postgres -- task-graph-issue-execution` | 首次 exit 0，第二次 exit 1 | 第二次自然复现 B verifying、C planned，见 [裁剪账本](issue-stall.json) |
| `npm run test:task-graph-postgres -- task-graph-s01-diagnostics` | exit 0，断言成功捕获 P2028 | 这是确认已知故障的诊断，不是修复通过。见 [延迟证据](slow-observation.log) |
| `AP_S01_REVIEW_RELEASE_PROBE=1 npm run test:task-graph-postgres -- task-graph-issue-execution` | exit 1 | 固定旧复核释放时刻，精确失败于“恢复必须启动新复核”的断言，见 [红色证据](review-release-red.log) |
| 同一释放探针，只在隔离源码中加入等待旧 Promise 后重试的对照 | exit 0 | A/B 分叉、B 有限回修、C 汇合及 tracker 幂等断言全部通过，见 [对照日志](review-drain-counterfactual.log) |

原始自然运行日志保留在本 worktree 的 `output/reviews/s01-reliability/`。提交的账本只保留本夹具的状态、复核结果和必要字段，不复制宿主环境或认证。S01 原始失败日志未修改。

## 1. 会话 P2028

最小场景是一个已交付 execution、一条后续问题、一次耗时 5200ms 的 writer 观察。直接调用真实 `startConversationFollowups(1)`，真实 PostgreSQL 默认事务上限为 5000ms。

该函数取得节点锁后，在事务内调用 `observeExecutionWriter`。真实观察可能继续进入 `observeTaskRunWriter`、`observeGraphWriter` 扫描 `/proc`。本探针只替换这一观察的延迟和返回，不修改事务、查询、状态转换或预算规则。结果在后续 `taskGraphEvent.findMany` 处得到 P2028，与 S01 堆栈位置一致。

回滚后完整 execution 行不变，reservation 未写入，原输入仍保留。证明了“慢外部观察占据数据库事务”足以触发该失败。没有测量历史故障当时每次 `/proc` 调用的耗时，不能把历史机器负载或具体进程数量当作已经证明的诱因。

诊断套件是显式选择的工具，不加入默认全量回归集合。它断言已知失败；修复实施时必须将其改为正确行为回归，不能把其 exit 0 记作修复成功。

## 2. B verifying、后继未放行

自然复现停在 `recovery-and-join`。只发生 A/B 各一次实施、各一次复核；A passed；B integrated/verifying，最后失败仍为 `blocked_require_human`，review 绑定已经消失；C planned。B revision 升至 339，但没有新的复核 TaskRun，也没有消耗修复或平台重试预算。

源码和受控探针共同确认如下时序：

1. 旧复核发布 attention，`activeReviews` 已清除，但 `verifyNode` 的 `nodeVerifications` Promise 尚在释放阶段 worker。
2. 恢复入口允许进入事务，`review_resumed` 删除旧 review 绑定，将节点改为 verifying。新 `reviewAttempt` 仅留在调用栈。
3. `verifyNode` 看到该节点已有 Promise，直接返回旧 Promise，新的恢复 attempt 没有执行。
4. 旧 Promise 结束后，周期再按固定候选计算默认 claimKey。旧候选的 `review_claimed` 事件仍存在，新的 review 绑定却不存在。领取返回 false，旧结果也无法按当前绑定恢复，于是函数直接返回。
5. 后续周期重复注册、释放 worker，只增加 revision。B 不通过，C 正确地保持等待。

探针在旧 B 复核写下 attention 后、释放 worker 前阻塞。测试发起原恢复函数，待数据库出现 verifying 后释放旧 worker。随后断言 B 至少启动第二次复核，在原实现中稳定为红。它没有模拟通过结果或删除旧 claim。

[隔离对照差异](counterfactual.diff) 仅把“遇到已有 Promise 直接返回”改为“显式恢复等待旧 Promise 后再次调用”。同一探针变绿，整条 Issue 流程通过。该对照已从最终源码中撤销。

这条一行改动用于确认根因，不作为最终修复：它仍依赖进程内调用栈，不能保证恢复事务提交后进程退出时接续。S02 必须持久化恢复 generation/claim，再由原协调器领取。

## 测试本身的额外发现

最初故障探针触发断言后，测试清理直接删除 Run，与尚未退出的 worker 事务发生 PostgreSQL `40P01`。测试现已先用现有 coordinator drain 等待任务结束，再清理临时数据。该夹具问题没有被混写成 B 停滞的根因。最终红色证据保留的是目标断言，不是清理死锁。

Issue 测试现在给超时加阶段名称，输出本夹具的节点、review TaskRun 和事件，减少 Prisma 对嵌套对象的 `[Object]` 截断。没有扩大生产日志。

## S02 结论及未验证内容

已定稿 [S02 最小边界合同](../../architecture/508_ARCH_20261020_MattPstackS02BoundaryContract.md)。先解决慢观察与短事务、持久恢复与进程内去重的交接，再迁移会话封口/正常再排队的状态写入。writer alive/unknown、claim、revision、固定候选、原预算保护继续保留。

本轮没有实现 S02、没有证明两个问题已修复，没有进行跨进程恢复的绿色验收，也没有执行全量测试、构建、生产健康检查或业务验收。隔离对照通过不代替这些验收。
