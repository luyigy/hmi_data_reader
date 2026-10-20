---
doc_type: REPORT
doc_status: completed
next_action: none
---

# P0：会话超时与复核恢复丢失

日期：2026-10-20。本轮止于两项 P0 修复、隔离回归和独立测试服务验证，不启动 S02–S04。

## 范围与基线

依据 [S01 审计](507_REPORT_20261020_MattPstackS01.md) 和用户本轮收窄要求，在分支 `fix/p0-task-graph-reliability`、worktree `/data1/code/agent-platform-p0-reliability` 工作。生产分支未变更。此前 `b5d28c9` 的较大 S02 实施留在原分支，本次只选取其中对应两项可靠性问题的代码，不整体合入。

审计源码基线为 `92b03b4`；本轮红色探针基线为 `4b61821`。两者 `src/` 差异为空，后者增加审计材料及复现夹具，未修复业务逻辑。重新读取原失败日志后，在独立基线 worktree 复现，再在 P0 worktree 跑绿色回归。

原日志没有改写，其 SHA-256 为：

- `conversation-retry.log`：`9a56b7040846522e02924e3117ba412ee00af02c5fbcaeaac6e0888b7d1d266e`。
- `issue-execution.log`：`a26019389f0488417b9767bcaa63acff8a96b152d7de4cca77a78a6ef7196222`。

本次未变更数据库 Schema、HTTP 权限、批准路线、业务 Ticket 状态或现有运行账本，未重启生产服务。所有测试账本位于 runner 创建并删除的 `task_graph_test_*` schema。

## 根因及修复

### 1. 后续会话领取中的 P2028

`startConversationFollowups` 取得节点锁后，在 Prisma 事务内调用 writer 观察。观察会读取 TaskRun 并扫描 `/proc`，耗时不受数据库控制。事务上限为 5000ms，观察超过此限后，后面的 `taskGraphEvent.findMany` 报 P2028。

修复将领取步骤提取为同文件中的 `reserveConversationFollowup`。读取身份、检查旧问答 writer、观察当前 writer 和准备新 worker 均在事务外；锁内重读 execution、TaskRun 和 reservation 事件，完全匹配才落账。变化时保留输入，交后续周期重新观察。没有增大事务超时。

退出证明仍绑定 claim/revision、候选、worker/release、TaskRun 控制元数据及参与者。alive 或 unknown 均不授权接管。并发领取仍由节点锁、输入归属和幂等键裁决，两个慢观察者只创建一个 reservation。

同一个 `task-graph-p0-timeout` 测试经原公开入口调用，在未修复基线因 P2028 失败，修复后成功。测试延迟真实 writer 观察 5200ms，未替换为虚构退出证明。

### 2. A passed、B verifying、C planned

实际丢失点位于旧复核的收尾与新恢复之间：

1. 旧复核已发布 attention，模型复核标记已清除，但节点 in-flight Promise 仍在释放阶段 worker。
2. 恢复事务允许进入，删除旧 review 绑定并改为 verifying。新的 recovery attempt 仅留在调用栈。
3. `verifyNode` 看到旧 Promise，直接返回它，新复核没有启动。
4. 后续周期按原候选计算 claimKey，撞上已存在的旧领取事件；当前绑定已被删除，旧结果也无法按归属回收，因而反复注册/释放 worker，B 不推进。C 继续等待是正确的依赖保护。

修复通过原恢复入口，将 requestId、新 ready review claim、固定候选及版本转换原子持久化。旧 Promise 只负责清理自己的 worker；本进程可在其结束后立即接续，普通周期也能读取未领取的新 generation。请求进程退出不再丢失恢复身份。

仍使用既有 progress.review、事件表、阶段角色和 `applyExecutionOutcomeTx`。重复请求幂等，竞争请求不能覆盖新状态，旧已领取记录仍走既有恢复适配器。没有删除历史 claim、扩大轮询、重置预算或把失败结论改为通过。

## 修改文件

| 文件 | P0 职责 |
| --- | --- |
| `src/lib/task-graph/conversation-followup.ts` | 同文件拆出领取步骤，移出慢观察，锁内复核身份和输入 |
| `src/lib/task-graph/writer-snapshot.ts` | 两项修复共用的观察快照及锁内身份比较 |
| `src/lib/task-graph/review-recovery.ts` | 持久登记经原入口授权的恢复 generation |
| `src/lib/task-graph/execution-progress.ts` | review_resumed 保留 ready 绑定、候选和预算 |
| `src/lib/task-graph/coordinator.ts` | 传递请求幂等身份、等待旧工作、消费持久 generation |
| `src/lib/task-graph/restart-recovery.ts` | 区分尚未领取的新 generation 与已领取但未派发的旧 claim |

测试变更为 `task-graph-p0-timeout`、`task-graph-p0-reservation`、`task-graph-p0-service`、原 `task-graph-issue-execution` 及标准 PostgreSQL runner 注册。原 timeout 诊断的“应当发生 P2028”断言已替换为正确行为回归；历史版本在 `4b61821` 保留。Issue 测试增加状态取证和测试服务握手，原终态、实施次数、回修次数及 500 轮上限不变。

会话封口/等待再排队仍留在原 inbox；没有引入上一版的状态模块搬迁、AST 消费者门禁、doctor 扩展或 phase-worker 改造。

## 红绿回归及状态证据

| 验证 | 结果 |
| --- | --- |
| 同一 timeout 测试在原基线运行 | exit 1，真实 P2028；[红日志](../evidence/matt-pstack-p0/timeout-identical-red.log) |
| 同一 timeout 测试在 P0 运行 | exit 0，延迟超过原事务上限仍只领取一次；[绿日志](../evidence/matt-pstack-p0/timeout-identical-green.log) |
| 固定旧复核释放时刻的 Issue 测试 | 原基线 exit 1，失败于“必须启动新复核”；P0 exit 0；[红](../evidence/matt-pstack-p0/review-red.log)、[绿](../evidence/matt-pstack-p0/review-green.log) |
| 原 interactive-conversation、execution-progress、conversation-delivery | exit 0；原会话、纠正输入、归属、退出证明、幂等和预算通过；[日志](../evidence/matt-pstack-p0/original-regressions.log) |
| P0 reservation 保护反例 | exit 0；拒绝变化的 claim/revision/候选/TaskRun 元数据，拒绝 alive/unknown writer，竞争领取仅一次；[日志](../evidence/matt-pstack-p0/reservation-guards.log) |
| 恢复请求进程退出后由普通周期接管 | exit 0；独立进程持久登记后退出，原周期完成恢复；重复 requestId 无额外写入，竞争请求被拒绝；[日志](../evidence/matt-pstack-p0/process-green.log) |
| 原 human review recovery | exit 0；成功兄弟不重做，原预算保持；[日志](../evidence/matt-pstack-p0/review-guards.log) |
| 静态工作流、TypeScript、长文件及源码差异检查 | exit 0；原静态模式/角色/Spec 检查通过，未启用 S02 门禁 |

原始红日志保留 Prisma 输出中的行尾空格；源码及其余非日志文件通过差异空白检查。

实际夹具转换、候选和预算见 [状态证据](../evidence/matt-pstack-p0/state-transitions.json)：A 保持通过；B 从材料决定暂停，经新 review claim 和一次有限回修到 passed；C 在 B 通过后自动启动并通过。原夹具仍断言实施序列为 A 一次、B 两次、C 一次，B 复核三次。

## 独立服务部署测试

用户同时要求“不重启生产服务”和“修复后部署服务测试”。本轮部署独立 Next.js 开发测试实例到随机 loopback 端口，注入专用临时 schema 和临时管理员身份。没有启动生产飞书或调度服务，没有继承宿主飞书凭据。测试结束后关闭测试进程并删除 schema。

运行方式：`npm run test:task-graph-postgres -- task-graph-p0-service`。服务部署套件显式选择，不在普通回归中默认启动 Web 服务。

健康检查、未认证 401、临时管理员登录以及 HTTP 读取本次 execution 对应的精确 TaskRun 均通过。HTTP 读取期间，夹具先保留 `A passed / B attention / C planned`，再经恢复到全部 passed；HTTP 读取本身不放行图节点。服务回执包含端口、隔离 schema 和实际源码 SHA-256，见 [回执](../evidence/matt-pstack-p0/service-receipt.json)、[测试输出](../evidence/matt-pstack-p0/service.log)、[Next 日志](../evidence/matt-pstack-p0/service-next.log)。

没有为测试打开被现有权限表拒绝的 `/api/task-graph-runs` HTTP 入口。该入口继续返回 404；图状态由隔离账本断言，HTTP 通过已开放的 TaskRun 查询接口核对执行归属。任务投影状态可能随旧清理变化，不能把它或 TaskRun completed 等同于 Slice passed。

模型、飞书和 tracker 使用原夹具替身；数据库、Git、相关沙箱检查和 HTTP 服务为真实实现。这是部署到隔离测试实例的验证，不是生产验收。

## Architect 边界与永久 Wire

保留的边界是：会话消费者不能凭文字自行宣布交付完成，恢复入口不能绕过 writer 退出及版本校验，复核发布不能消费不匹配的候选。P0 只把这两处交接做成可审计的身份绑定，没有建立第二个调度器或任意字段 setter。

值得永久保留的 Wire 是行为回归：慢观察超过 5000ms、观察后身份变化、活跃/未知 writer、旧复核收尾竞态，以及恢复 requestId 的持久性和幂等性。它们验证真实事务及状态后果。全局状态字段写入 AST 门禁须先确定职责归属，留给后续 S02，不在本次顺带实施。

## 残余风险与停止点

- writer 无法证明退出时仍保留现场，不靠超时或缺少进程登记猜测接管。
- 已经因旧版本删除 review 绑定而损坏的生产现场，没有被本次自动修补。需单独核对原恢复授权、claim、候选和 writer 证据。
- 本次只处理两个失败调用链，没有迁移全仓所有事务内 I/O，也没有执行全量测试或真实模型、飞书、浏览器业务验收。
- 隔离服务验证通过不表示生产已上线。生产分支、服务和业务账本均保持原状。

建议的最小 S02 为一片：确定会话封口与正常等待再排队的账本接口，迁移全部对应调用方，再加一条禁止消费者直接写 phase/status 的静态 Wire。保留原会话、输入幂等、候选和预算作为验收。Issue/Harness 分层、Inspector、Gardening 不与该片捆绑。

本轮 P0 到此停止；上述 S02 仅为建议，不自动创建或派发下一阶段。
