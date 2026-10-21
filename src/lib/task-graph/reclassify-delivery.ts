import { isFeishuAdmin } from '../feishu-access-approval';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { isRecord } from './implementation-result';
import { resolveRunIssueSource } from './issue-adoption';
import { applyExecutionOutcomeTx, executionProgress } from './execution-progress';

/** Explicit operator correction, bound to the audited approval and execution; never infer delivery from free text. */
export async function reclassifyIncompleteDelivery(args: {
  runId: string; nodeKey: string; snapshotHash: string; executionId: string; taskRunId: string; commit: string;
  actorId: string; reason: string; evidencePath: string; blockerKind: 'missing_business_material' | 'environment_failed';
}) {
  if (!isFeishuAdmin(args.actorId)) throw new Error('仅平台管理员可执行交付重分类');
  if (!/^[0-9a-f]{40,64}$/.test(args.commit)) throw new Error('无效交付提交');
  if (!args.reason.trim() || !args.actorId.trim() || !args.evidencePath.trim()) throw new Error('重分类需要操作者、审计证据与原因');
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId } });
  await graphGit(job.repository, 'cat-file', '-e', `${args.commit}^{commit}`);
  if (!(await graphGit(job.repository, 'for-each-ref', '--contains', args.commit, '--format=%(refname)')).trim()) throw new Error('原交付缺少 Git 引用保护');
  const source = await resolveRunIssueSource(args.runId);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE "runId" = ${args.runId} ORDER BY id FOR NO KEY UPDATE`;
    const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: args.runId }, include: { nodes: { include: { executions: true } } } });
    const found = run.nodes.find(item => item.key === args.nodeKey);
    if (found) await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${found.id} FOR NO KEY UPDATE`;
    const node = found ? await tx.taskGraphNode.findUnique({ where: { id: found.id }, include: { executions: true } }) : null;
    if (!node || run.snapshotHash !== args.snapshotHash) throw new Error('审批版本或目标不匹配');
    const key = `node:${node.key}:reclassify:${args.taskRunId}`;
    const prior = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: run.id, idempotencyKey: key } } });
    if (prior) {
      if (!isRecord(prior.payload) || prior.payload.executionId !== args.executionId || prior.payload.commit !== args.commit) throw new Error('重分类幂等键与原目标不符');
      return prior;
    }
    const current = node.executions.find(item => item.id === args.executionId);
    if (node.status !== 'delivered_unverified' || node.executions.length !== 1 || current?.status !== 'integrated' || current.taskRunId !== args.taskRunId || current.commit !== args.commit) throw new Error('交付已改变，不能重分类');
    const descendants = new Set([node.key]);
    for (let changed = true; changed;) { changed = false; for (const item of run.nodes) if (!descendants.has(item.key) && item.dependsOn.some(key => descendants.has(key))) { descendants.add(item.key); changed = true; } }
    if (run.nodes.some(item => item.id !== node.id && descendants.has(item.key) && !['planned', 'ready'].includes(item.status))) throw new Error('后继已执行，须先审计影响，不能静默撤销前置交付');
    if (await tx.taskRun.count({ where: { taskId: { in: [current.childTaskId || '', `task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] }, status: { in: ['pending', 'running'] } } })) throw new Error('仍有活跃执行，保留现场');
    const metadata = current.dispatchMetadata;
    const workspaceBase = isRecord(metadata) && typeof metadata.workspaceBase === 'string' ? metadata.workspaceBase : current.baseCommit;
    const event = await tx.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, idempotencyKey: key, kind: 'node_delivery_reclassified',
      payload: { ...args, recoveryKind: 'implementation', blockedPhase: 'implementation', checkpointCommit: args.commit, workspaceBase,
        previousStatus: node.status, previousEvidence: current.evidence, previousDispatch: current.dispatchMetadata } } });
    const recoveries = await tx.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: 'conversation_review_recovery_requested' } });
    if (recoveries.length) await tx.taskGraphEvent.createMany({ data: recoveries.map(request => ({ runId: run.id, nodeId: node.id,
      idempotencyKey: `conversation:review-recovery:${request.id}:started`, kind: 'conversation_review_recovery_superseded', payload: { reclassificationId: event.id } })), skipDuplicates: true });
    const progress = executionProgress(current.dispatchMetadata);
    if (progress) {
      if (!current.claimToken) throw new Error('缺少原交付执行归属');
      await applyExecutionOutcomeTx(tx, { executionId: current.id, claimToken: current.claimToken, expectedRevision: progress.revision,
        outcomeId: `reclassification:${event.id}`, outcome: { kind: 'delivery_reclassified', authorization: event.id,
          failure: { code: args.blockerKind, detail: args.reason } } });
    } else await tx.taskGraphExecution.update({ where: { id: current.id }, data: { issueKind: args.blockerKind } });
    await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention', passedAt: null } });
    await tx.taskGraphNode.updateMany({ where: { runId: run.id, key: { in: Array.from(descendants).filter(key => key !== node.key) }, status: 'ready' }, data: { status: 'planned' } });
    await tx.taskGraphRun.updateMany({ where: { id: run.id, status: { not: 'paused' } }, data: { status: 'attention' } });
    const ticket = source?.tickets.find(ticket => ticket.key === node.key);
    if (ticket) await tx.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, idempotencyKey: key + ':issue', kind: 'issue_reopen_requested', payload: { ref: ticket.ref, reason: args.reason, reclassificationId: event.id } } });
    return event;
  });
}
