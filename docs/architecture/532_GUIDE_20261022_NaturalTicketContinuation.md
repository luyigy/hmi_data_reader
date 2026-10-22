# Ticket 持续执行：架构与源码导览

仓库 `agent-platform-v2`，分支 `fix/natural-ticket-continuation-20261022`。源码固定为 `c50c0eef2cd2c66a73f698a9b63e91537cf10c69`；A 为 `e1d4812bf58fb51f015ad88bdae1ddb587f39494`。未部署、未恢复生产 Ticket。

## 1. 整栋系统

当前改动位于 Task Graph 调度层的继续入口、原会话绑定与事务边界。

```text
用户批准的 Spec / Tickets / 原 Topic
  └─ Task Graph / Coordinator                      本次修改
      ├─ 工作领取、继续请求、Topic 输入、条件就绪
      ├─ Coding Agent → 原 Native Session / Worktree
      └─ Git 集成 → 独立 Verifier → 合格后继
基础设施边界：Project Capabilities / Sandbox Manager / W001 / Writer / CAS
```

## 2. 当前楼层：减少阻塞

普通工程问题进入原工作循环；Agent 的问题由原 Agent 提出。当前阶段请求仍经过 W001；新输入不扩大权限；未知 Writer 不能被当作已退出。

## 3. 房间：文件与函数

| 职责 | 固定源码位置 | 改动或保留边界 |
| --- | --- | --- |
| 继续请求 | [src/lib/task-graph/conversation-recovery.ts:49](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/conversation-recovery.ts#L49) | 有调度回执才消费；失败留待重领。 |
| 原 Agent 工作 | [src/lib/task-graph/implementation-result.ts:53](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/implementation-result.ts#L53) | 普通障碍继续工作，实际问题由原 Agent 提出。 |
| Topic 回复 | [src/lib/task-graph/conversation-inbox.ts:239](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/conversation-inbox.ts#L239) | 核验输入、退出证明和当前身份后走正常领取。 |
| 原生会话 | [src/lib/task-graph/conversation-session.ts:7](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/conversation-session.ts#L7) | 失败轮次缺少 ID 时，取回同一 TaskSession 的可靠历史 Session。 |
| 原领取入口 | [src/lib/task-graph/coordinator.ts:736](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/coordinator.ts#L736) | 现有 Coordinator 领取；正常工作优先，空闲槽位复核条件。 |
| 结果事务 | [src/lib/task-graph/execution-progress.ts:171](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/execution-progress.ts#L171) | 事务外观察 Writer，事务内核对身份与 CAS。 |
| 退出证明 | [src/lib/task-graph/task-run-exit-proof.ts:16](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/task-run-exit-proof.ts#L16) | 观察真实进程，保存并比对 TaskRun / 参与者身份。 |
| 条件就绪 | [src/lib/task-graph/preparation-recovery.ts:145](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/preparation-recovery.ts#L145) | 实施和固定候选验收各回原正常路径，不清历史计数。 |
| 资源预检 | [src/lib/task-graph/runtime-continuity.ts:55](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/runtime-continuity.ts#L55) | 用当前授权和固定候选预检，保留原 Pin。 |
| 权限权威 | [src/lib/project-capabilities/context.ts:11](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/project-capabilities/context.ts#L11) | Project Capabilities 仍决定资源权限，事务内复核批准身份。 |
| 技能依赖 | [src/lib/task-graph/runtime-preflight.ts:79](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/task-graph/runtime-preflight.ts#L79) | 逐包核验声明、摘要与宿主只读授权。 |
| 工具错误 | [src/lib/project-capabilities/table-data.ts:21](https://github.com/luyigy/agent-platform-v2/blob/c50c0eef2cd2c66a73f698a9b63e91537cf10c69/src/lib/project-capabilities/table-data.ts#L21) | 保留 InvalidFilter 等原始错误，不统一包装成授权失败。 |

## 4. 走廊：调用链

```text
Topic 新输入
  reconcileConversationWaits
    输入归属 + Writer 快照 + 固定候选核对
    原 execution 变成可领取工作
  runTaskGraphCycle
    claimExecution → executeJob
      implementationConversation
      executeAcpxTaskRun → W001 Dispatcher → Sandbox Manager → Native Session

平台条件修复
  Coordinator 空闲槽位
    reconcileExecutionConditions
      事务外预检 → 短事务核对原身份
    原实施 → 正常 claimExecution
    原验收 → scheduleVerificationRecovery → verifyNode
```

这两条链没有新建 Scheduler。旧恢复事件仍兼容，原请求有实际调度回执才消费。

## 5. 砖块：真实源码前后对照

下列代码是指定 SHA 的原样摘录，未插入教学注释。中文解释在代码块后。

### 修改前：请求先被消费

【真实源码 · src/lib/task-graph/conversation-recovery.ts:59 · SHA `1f5dcf597f90f5c5d932fad8e879f0b9d42074a1`】

```ts
    try { await prisma.taskGraphEvent.create({ data: { runId: request.runId, nodeId: node.id, idempotencyKey: key, kind: 'conversation_review_recovery_started', payload: {} } }); }
    catch (error) {
      if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: request.runId, idempotencyKey: key } } })) continue;
      throw error;
    }
    await prisma.taskGraphEvent.createMany({ data: requests.filter(other => other.nodeId === node.id && other.id !== request.id).map(other => ({
```

1. 先写 started，再进行真正调度。
2. 调度后续失败时，旧扫描逻辑仍跳过这个 started。

### 修改后：以持久调度回执确认消费

【真实源码 · src/lib/task-graph/conversation-recovery.ts:83 · SHA `c50c0eef2cd2c66a73f698a9b63e91537cf10c69`】

```ts
      const receipt = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: {
        runId: request.runId, idempotencyKey: `node:${node.key}:${recoveryKind}-recovery:${request.id}` } } });
      if (!receipt) return;
      await prisma.taskGraphEvent.createMany({ data: [
        { runId: request.runId, nodeId: node.id, idempotencyKey: key, kind: 'conversation_review_recovery_started', payload: { receiptId: receipt.id } },
        { runId: request.runId, nodeId: node.id, idempotencyKey: key + ':finished', kind: 'conversation_review_recovery_finished', payload: { receiptId: receipt.id } },
        ...requests.filter(other => other.nodeId === node.id && other.id !== request.id).map(other => ({
          runId: other.runId, nodeId: node.id, idempotencyKey: `conversation:review-recovery:${other.id}:started:finished`,
          kind: 'conversation_review_recovery_superseded', payload: { supersededBy: request.id, receiptId: receipt.id },
        })),
```

1. 读取原调度函数在 node lock 下写入的 requestId 回执。
2. 没有回执就保留原请求，不消费。
3. 有回执才记录开始与完成；重复扫描不能产生第二次有效领取。

### 修改前：按 blocked 类别停到决定

【真实源码 · src/lib/task-graph/implementation-result.ts:68 · SHA `1f5dcf597f90f5c5d932fad8e879f0b9d42074a1`】

```ts
  if (progress) return applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
    expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:decision_required`,
    outcome: { kind: args.result.blockerKind === 'environment_failed' && args.result.status === 'blocked' && args.result.blockerCause === 'transient' ? 'platform_retry' : 'decision_required',
      failure: { code: args.result.blockerKind, detail: args.result.note, blockedPhase: args.blockedPhase || 'implementation',
        ...(args.result.status === 'blocked' && args.result.blockerCause ? { blockerCause: args.result.blockerCause } : {}),
        ...(args.result.blockerKind === 'environment_failed' ? { owner: 'platform' as const, requiresUserDecision: false,
          action: args.result.status === 'blocked' && args.result.blockerCause === 'transient' ? '按已有预算重试暂时平台故障' : '准备并验证缺少的运行能力后从已保存候选继续；环境不变时不重复实施' } : {}) } },
  });
  return prisma.$transaction(async tx => {
```

1. 除材料问题的特例外，其余 blocked 多进入 decision_required。
2. 模型给出的标签成为是否需要人介入的主要依据。

### 修改后：普通工作与原 Agent 的问题

【真实源码 · src/lib/task-graph/implementation-result.ts:66 · SHA `c50c0eef2cd2c66a73f698a9b63e91537cf10c69`】

```ts
  if (progress && progress.phase === 'implement' && (args.blockedPhase || 'implementation') === 'implementation') return applyExecutionOutcome({
    executionId: args.executionId, claimToken: args.claimToken, expectedRevision: progress.revision,
    outcomeId: `${args.claimToken}:${progress.revision}:engineering-work`,
    outcome: ['permission_required', 'scope_change'].includes(args.result.blockerKind)
      ? { kind: 'waiting_for_user', note: args.result.note }
      : { kind: 'continue_work', note: args.result.note, fingerprint: await continuationWorkFingerprint(args.executionId, args.checkpointCommit) },
  });
  if (progress) return applyExecutionOutcome({ executionId: args.executionId, claimToken: args.claimToken,
    expectedRevision: progress.revision, outcomeId: `${args.claimToken}:${progress.revision}:decision_required`,
```

1. 只作用于当前实施阶段，保留原 claim 与 revision。
2. 权限或范围问题保存为 Agent 的问题，新回复自然续接。
3. 其余障碍按真实工作指纹继续；同样输入无进展时停止空转。
4. 这里没有授予任何资源权限。实际访问仍由 Project Capabilities / Sandbox 检查。

## 教学伪代码

【教学伪代码 · 流程概括 · 不存在于仓库】

```text
获批的 Ticket 有新的工作事实时：
  确认没有被用户暂停
  确认原 Writer 已退出，输入与候选没有漂移
  在原授权范围内领取下一轮
  原 Agent 用原会话调查、编码、提问、修复
  没有进展时停止空转，保留会话与资格
  交付通过独立验收，才放行相应后继
```

## 证据与适用边界

- A：真实数据库超时后请求不丢；慢 Writer 观察不再占用事务。候选与 Writer 身份漂移仍拒绝。
- B：一次真实失败轮次后原 Native Session 连续；旧格式问题经原 Topic 回复继续；独立验收后后继启动。
- 条件就绪：实施与验收分别验证了历史计数 77 不被清零，仍可在条件恢复后继续。
- 构建实际运行 W001 与真实已安装 Codex 的本地协议夹具；生产业务与双 Ticket 真实执行时间重叠尚未验证。
- 受控冲突 Stage 的 blocked 分支、Verifier 协议错误/业务裁决仍保留旧兼容入口。当前旧 Pin 与新增工具授权的生产迁移没有自动执行。
- 四个技能依赖的目录和摘要已列成提案，尚未授予新权限。独立 NISSEI 留样授权也没有擅自扩大。

完整行为、红绿日志和生产前置项见 [B 报告](531_REPORT_20261022_NaturalTicketContinuation_B.md) 与 `docs/evidence/natural-ticket-continuation-20261022/`。不把本次隔离通过当作 Reader/Mold 业务已交付。
