# Natural Ticket continuation, commit A

基线 `1f5dcf5`。实施分支 `fix/natural-ticket-continuation-20261022`，独立开发 Worktree。未部署，未修改或恢复生产任务。

## 已修改的控制流

- conversation-recovery：请求的 started/finished 只在现有调度器的持久 scheduling receipt 存在后写入。失败事件不消费请求。两个扫描者可以尝试同一个 requestId，最终领取仍由原 node lock、request key 和 Writer CAS 决定。兼容旧 started 但未成功调度的请求，不删除旧事件。
- execution-progress：事务外观察实际进程；短事务核对相同 TaskRun、原生 Session、参与者 Writer 身份以及原执行快照。观察期间候选或运行身份变化则拒绝。TaskRun 状态变更不是退出证明。restart 和 Verifier 回修同样传递观察结果。
- implementation-result、conversation-inbox、review-publication：将 Writer 观察和 Git MERGE_HEAD 查询移出事务，回到事务后按原 jobs/TaskRuns 快照校验。
- runtime-continuity：Git、realpath、声明摘要、Python 配置和宿主 Policy 读取在事务外；Project Capabilities 的事务内部分使用当前 tx，重新核对批准快照、Scope 回执和请求人。声明来源没有改成授权权威。
- preparation-contract/preparation-recovery：历史兼容入口的文件摘要和进程扫描也移出事务；事务内仍检查固定回执内容、binding、claim/revision、候选、TaskRun 和 Writer 快照。不增加 Prisma timeout。

没有调整失败预算、恢复次数、沙箱挂载或生产批准快照。

## 真实红绿证据

见 `docs/evidence/natural-ticket-continuation-20261022/A/`。

红：

1. `node scripts/test-task-graph-postgres.mjs task-graph-implementation-recovery`，真实 PostgreSQL transaction timeout 后旧实现仍写 started，断言 `1 !== 0`。
2. `node scripts/test-task-graph-postgres.mjs task-graph-execution-progress`，故障注入使真实 Writer 观察耗时超过默认 5 秒，旧实现在事务内触发 P2028。修复没有增加等待或延长 timeout。

绿：

- 同一请求超时后重试，两个并发领取者最终只有一个 scheduling receipt；原 Worktree 与原生 Session 保留。
- 慢观察不再耗尽事务；观察期间候选漂移、TaskRun Writer 元数据漂移拒绝；真实存活 nonce 后代仍阻止派发。
- execution-progress、restart-recovery、targeted-repair 已通过。implementation-recovery、runtime-pinning、project-capabilities-c02、project-capabilities-scope-change、preparation-recovery、prepared-review、stage-authority 整批通过。
- 每次数据库测试入口均先执行 W001，包含 20 个 AST 反例和 5 个源码变异；TypeScript 和长文件守卫通过。

未将旧套件全绿作为已完成事实。`task-graph-review-repair` 缺少 `validation_workspace_cleaned` 回执，在未修改的 `1f5dcf5` 也失败，保存了对照日志。interactive-conversation 的旧 completed followup 重试断言和 conversation 的旧验收 fixture 也在进一步核实。它们不以放松 Writer 或结果保护修过。

## 边界

这是事务与领取可靠性提交。普通工程障碍仍按旧分类处理，属于后续 commit B。部署、Reader/Mold 原图恢复、真实 Codex 业务交付和两个生产 Ticket 时间重叠均未执行，待用户另行确认。
