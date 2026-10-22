# 获批 Ticket 的统一放行：实现与验证

## 固定版本与范围

- 基线：`9a11e31c3c7443f2ca0ecb9bd523e57dc176f92f`。
- 核心收敛：`659a6b0f4d751193c224cee2812f62638d859ab8`。
- 最终业务源码：`c46bcdc53dc2e9f06daef25a430f5953ce825f71`。
- 回归夹具隔离：`1ae37a32911faf76605f408928fe9c81305ff823`。该提交只增加 T1 的后台工作 drain，不改业务源码。
- 分支：`fix/unified-ticket-admission-20261022`。
- 生产仍是原版本；本轮没有合并、部署、恢复生产 Ticket 或修改生产预算、批准快照。

本次改动位于 Task Graph 调度层。Graph 安排工作，原 Coding Agent 调查、提问和实施，Verifier 判断固定交付是否合格。普通错误不通过历史 owner 标签或累计失败次数撤销原工作资格。

## 整栋系统

```text
批准路线与 Ticket
        |
输入、继续请求、准备回执、条件变化等已有账本事实
        |
Coordinator 发现待办与到期检查
        |
admitNode：观察、预检、短事务复核
        |
applyExecutionOutcomeTx：唯一 execution 状态写入权威
        |
正常 claim -> 原 Native Session / Worktree -> 集成 -> 独立验收 -> 后继

始终保留：Project Capabilities / Sandbox / 单 Writer / claim-revision
          W001 / 候选 CAS / 固定验收输入 / 合格上游
```

可信服务兼容入口也调用同一个放行函数。放行表示可由正常调度领取，不是资源授权，也不代表模型已经启动。

## 当前楼层与房间

所有业务文件位于 `src/lib/task-graph/`。

| 文件 | 实际修改 |
| --- | --- |
| coordinator.ts | 不再按历史 owner 过滤待办；保留现有并发槽和正常 claim；重检先观察轻量事实和到期时间 |
| preparation-recovery.ts | admitNode 统一实施、用户输入、材料交接、验收及准备回执；阶段预检在事务外；回执和放行原子提交 |
| execution-progress.ts | 增加 admitted/admission_deferred 结果，复用原状态枚举；删除 operator_resume/review_resumed/review_platform_prepared 写入分支；新失败诊断补齐 owner 和 requiresUserDecision |
| implementation-result.ts | 旧继续 API 变成薄兼容入口，删除专用资格判断和无 progress 直接写 ready |
| conversation-inbox.ts | 保留真实消息鉴权和输入回执；回复、材料交接接入 admitNode；锁内复核原消息及作者身份 |
| conversation-recovery.ts | 消费实际放行回执；暂时失败保留原请求；兼容原实施和验收回执键 |
| review-recovery.ts | 旧验收恢复 API 调用统一入口，保留固定候选和 review generation |
| failure-summary.ts / overview.ts | 不将负责人推断表达为已经执行；区分等待领取、待启动、真实本轮运行及等待输入；耗尽不表达为永久失去资格 |
| runtime-continuity.ts | 去掉保存运行时检查中的第三处 owner 前提；原 Pin、真实授权、候选和资源身份核验保留 |
| writer-snapshot.ts / task-run-exit-proof.ts | 复用 Writer 身份字段，摘要和活动时间不使退出证明失效；nonce、Session、参与者、controlState、活跃生命周期变化仍拒绝 |

原计划的九个文件之外，增加三个必要文件。回归证明 runtime-continuity 也按 owner 拦截，Writer 快照则把展示性字段误当身份。这些修改属于同一继续调用链，没有增加调度器或数据库状态机。

## 走廊：现在怎样继续

1. 用户新回复保留为 conversation_input；明确继续和准备回执保留原持久事实。
2. Coordinator 优先处理正常 ready 工作，利用空闲槽检查保存点。
3. admitNode 根据真实等待原因判断下一步；owner 只作诊断。exhausted 本身不撤销资格。
4. 锁外确认 Writer 实际退出、工作区 HEAD 与候选一致、没有未受控合并，并进行阶段预检。被清理的 checkout 只从原受保护分支按原身份重建。
5. 短事务核对 run 暂停、节点、批准快照、执行成员、Writer、输入和 revision，然后调用公共状态函数。
6. 没有其他活跃实施者时，节点恢复 ready 并清除旧 node claim；存在活跃兄弟执行时保留其 claim。否则下一轮交付会撞上旧幂等键。
7. 放行、准备回执消费和已经覆盖的继续请求确认在同一事务提交。消息材料仍由 bind/seal 绑定到原 Agent 本轮，不提前标记已交付。
8. 实施按 execution 判断，不制造同节点隐式依赖；验收必须绑定整个节点的全部固定候选及同一 review generation。

### 砖块：真实源码与中文对照

以下是 `c46bcdc` 的真实源码节选，省略了前后的预检与回执逻辑。

[`preparation-recovery.ts:285`](https://gitee.com/luyi1678/agent-platform-v2/blob/c46bcdc53dc2e9f06daef25a430f5953ce825f71/src/lib/task-graph/preparation-recovery.ts#L285) 位于同一个短事务中：

```ts
for (const entry of observations) {
  const { job, progress, exit, review } = entry;
  const phase: ExecutionPhase = review ? progress.phase : wake.source === 'conditions' ? progress.phase : 'implement';
  await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken!, expectedRevision: progress.revision,
    outcomeId: `admit:${wake.source}:${wake.id}:${progress.revision}`, outcome: { kind: 'admitted', requestId: wake.id,
      stage: review ? { kind: 'review', phase: progress.phase === 'architecture' ? 'architecture' : 'acceptance', claimKey: `admit:${wake.id}` }
        : { kind: 'implementation', phase } } }, exit, job);
```

- 第 285–286 行逐个处理通过检查的执行记录，不让等待权限的兄弟实施记录成为隐式依赖。
- 第 287 行保留条件修复前的阶段；用户明确要求重新实施时，回到 implement。验收保留原验收阶段。
- 第 288 行携带原 claim 和 revision，状态函数仍检查 CAS。
- 第 289 行用来源、请求和 revision 标识本次结果，避免重复安排。
- 第 290–291 行区分实施与固定候选验收，并传入锁外退出证明及原执行快照。

[`conversation-recovery.ts:83`](https://gitee.com/luyi1678/agent-platform-v2/blob/c46bcdc53dc2e9f06daef25a430f5953ce825f71/src/lib/task-graph/conversation-recovery.ts#L83) 的真实节选：

```ts
const receipt = await prisma.taskGraphEvent.findFirst({ where: { runId: request.runId, nodeId: node.id,
  idempotencyKey: { in: [`node:${node.key}:implementation-recovery:${request.id}`, `node:${node.key}:verification-recovery:${request.id}`] } } });
if (!receipt) return;
```

- 第 83–84 行同时查询实施和验收的真实安排回执。
- 第 85 行表示没有回执就不消费请求，下轮可以再取。这包含预检失败、事务超时以及竞争导致的快照过期。
- 有回执才确认已安排；安排并不等于模型已经执行，也不等于交付通过。

基线 `9a11e31` 的旧筛选片段已删除：

```ts
path: ['progress', 'lastFailure', 'owner'],
equals: 'platform'
```

它曾在任何预检之前排除缺字段的历史记录。最终代码还移除了准备恢复和保存运行时检查中的同类条件。

### 教学伪代码，不是仓库原文

```ts
const observations = await inspectCurrentStage(node, wake);
await transaction(async tx => {
  await assertRunActiveAndLockNode(tx);
  await recheckApprovalInputsWriterAndCandidate(tx, observations);
  await applyExecutionOutcomeTx(tx, admission, observedExit, exactExecution);
  await updateNodeAggregateAndAcknowledgeWake(tx);
});
```

## 空转、退避和安全边界

- 工作空转继续使用现有 distinct work fingerprint 和 maxUnchangedWorkTurns，不因重复回复镜像或新 Turn ID 伪造进展。
- 平台条件使用 conditions-ready 身份去重；暂时预检失败写入可重查事实，复用 nextRetryAt 并指数退避，最长五分钟，不启动模型。
- 路线恢复、依赖状态及已批准范围事件进入条件版本；实际资源权限仍由 Project Capabilities、原运行时 Pin 和执行边界确认。
- scope change 事实必须来自本执行真实、晚于原决定的批准记录，不能由 wake 的任意布尔值授予。
- 不合格上游、用户暂停、未知或活跃 Writer、候选漂移、未授权资源继续阻止相关工作。
- 受控冲突仍交给已有只读源码/批准产物目录流程，本入口不绕过 MERGE_HEAD 或 conflictRepair。

## 红绿证据与机器入口

证据目录：`docs/evidence/unified-ticket-admission-20261022/`。命令、固定代码 SHA、退出码与日志校验值见 manifest.json。

29 个不同 PostgreSQL 隔离回归套件通过：13 个行为、14 个安全、2 个验收/Issue 兼容。TypeScript、长文件守卫及生产构建通过。安全和构建固定在 c46bcdc，最终行为和兼容回归固定在 1ae37a3；两者业务源码完全相同。

| 用例 | 真实观察 |
| --- | --- |
| 旧记录缺 owner | 红：PEER 已交付，旧保存点一直未领取。绿：原保存点继续，候选和 Worktree 保留，历史计数 77 不变 |
| TaskRun 晚到摘要 | 红：Writer 已退出，但仅更新摘要/时间就使快照核验失败。绿：这些字段可变化，替换 Writer nonce 仍拒绝 |
| 原继续请求遇到事务超时 | 真实 P2028 不消费请求；二十条较新的已消费请求不遮住它；并发扫描只安排一次 |
| 原 Agent 多轮工作 | 原 Session / Worktree 保留；合法 Topic 输入绑定、去重；无进展停止后有效新输入或明确继续可接回 |
| Verifier 回修 | 三个不同范围内缺陷回原实施者，四份固定候选独立检查，后继只释放一次 |
| 准备回执 | 已安排和回执消费原子提交；重复证据不产生第二轮；未知 Writer、篡改材料、候选和批准漂移仍拒绝 |
| 并行与节点 claim | 暂停或等待权限的兄弟记录不阻止合格独立实施；有活跃兄弟时不清除其 node claim；新实施代次不复用旧交付键 |

`npm run check:ticket-admission` 检查当前 Task Graph 顶层 TS 模块的直接 Prisma ready 写入及字面量旧恢复 outcome。它已接入 npm prebuild 和 PostgreSQL 回归入口；planned 到 ready 的依赖释放保留。

这是针对当前调用点的结构门禁，不宣称覆盖动态别名、运行时生成代码、外部 JS 或目录外新增写入。它与行为回归配合，也不被命名为新的永久 Gardening Wire。

`npm run build` 的 prebuild 还运行 W001 与 W01。W01 使用真实已安装 Codex 和确定性本地 provider，验证原生 Thread 续接和 Manager 隔离；它不是生产模型完成 Reader/Mold 业务的证明。

## 改动规模与验证限制

本轮相对基线有 26 个代码、脚本和测试文件变更，651 行增加、361 行删除，净增加 290 行。没有达到“文件总行数减少”的原估计，主要新增是统一放行的原子事务、阶段预检和实际安全回归。减少的是独立放行决策与旧 outcome 分支，不能把代码行数增加说成减少。

完整行为批次在 `c46bcdc` 上遇到过一次 T1 的 `writer_or_candidate_changed`。带诊断的独立三连跑未复现，未取得字段差异，因此不声称已证明具体竞争字段。T1 之前在启动四轮后台探测后直接调用一次性兼容 API；新夹具先 drain，再验证显式继续的一轮语义。实际并发请求、暂时失败不丢失和 CAS 拒绝继续由 admission / implementation-recovery 回归验证，没有修改或放宽业务快照检查。

兼容 API 遇到暂时快照变化仍可返回 typed deferred。持久消息消费者保留原请求并重试；直接调用兼容 API 的服务调用者必须保留请求并按结果重试。未经生产现场验证，不宣称所有旧任务都能自动恢复。

## 保留的历史兼容与未完成的生产验收

- 原 scheduleImplementationRecovery、scheduleVerificationRecovery、材料交接和准备回执接口保留为兼容入口，实际放行收敛到 admitNode。
- 原历史账本、原 Pin、旧 Session 和各类计数保留。无真实本地 Writer/Session/保存点证据的旧记录不会被猜测修复。
- restart-recovery、受控冲突与显式 legacy adoption 保留原安全职责；本轮没有开展全仓历史协议清理。
- review-publication.ts、review-result.ts 及旧 outcome 的单轮重试限制暂留，仍可能写 exhausted；统一放行不再据此永久拒绝。条件和输入不变时去重停转，出现实际新事实后重检，不自动清空旧计数。
- 旧 Issue 显式验收恢复 fixture 隔离新自动消费者，以验证兼容回执；自动路径由 condition-recheck/admission 独立验证。
- 生产 BOLE 的容量、ARBURG 的实际技能装配、FANUC 已授权原图、NISSEI 新增资料权限、YIZUMI 上游质量仍须逐项以现场事实验证。代码通过不表示业务票已恢复。

生产验收需单独批准合并、部署及相关路线恢复。随后从合法保存点走正常 Coordinator，不手改 owner、状态、预算或批准快照。必须记录至少两个真实 Codex 的执行时间重叠、原 Session、Worktree、Manager 身份，以及 Reader API/CLI、Mold 页面/API、测试和后继释放结果。
