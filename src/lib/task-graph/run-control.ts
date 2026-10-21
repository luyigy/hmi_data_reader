import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requestRunControl } from '../acpx/process-registry';

export function graphRunBusinessStatus(nodes: { status: string }[]) {
  if (!nodes.length) throw new Error('Unknown or empty task graph run');
  return nodes.every(node => ['passed', 'delivered_unverified'].includes(node.status))
    ? nodes.some(node => node.status === 'delivered_unverified') ? 'completed_unverified' : 'completed'
    : nodes.some(node => node.status === 'attention') ? 'attention' : 'running';
}

export class GraphRunPausedError extends Error {
  constructor(readonly runId: string) { super('Task graph is paused by the user'); this.name = 'GraphRunPausedError'; }
}

/** Serialize user control with new reservations; candidate/result ownership remains unchanged. */
export async function graphRunCanStartTx(tx: Prisma.TransactionClient, runId: string): Promise<boolean> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'graph-control:' + runId}, 0))`;
  const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
  return run.status !== 'paused';
}

export async function requireGraphRunActiveTx(tx: Prisma.TransactionClient, runId: string) {
  if (!await graphRunCanStartTx(tx, runId)) throw new GraphRunPausedError(runId);
}

export async function requireGraphRunActive(runId: string) {
  return prisma.$transaction(tx => requireGraphRunActiveTx(tx, runId));
}

export async function graphRunIsPaused(runId: string) {
  return (await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } })).status === 'paused';
}

export async function requireGraphNodeActiveTx(tx: Prisma.TransactionClient, nodeId: string) {
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, select: { runId: true } });
  await requireGraphRunActiveTx(tx, node.runId);
}

export async function requireGraphNodeActive(nodeId: string) {
  return prisma.$transaction(tx => requireGraphNodeActiveTx(tx, nodeId));
}

/** Operator control changes no node, candidate, session, claim, permission or retry count. */
export async function setGraphRunPaused(args: { runId: string; paused: boolean; requestId: string; actorId: string; reason: string }) {
  if (![args.requestId, args.actorId, args.reason].every(value => value.trim())) throw new Error('Run control requires request, actor and reason');
  return prisma.$transaction(async tx => {
    await graphRunCanStartTx(tx, args.runId);
    const idempotencyKey = `user-run-control:${args.requestId}`;
    const previous = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey } } });
    const kind = args.paused ? 'run_user_paused' : 'run_user_resumed';
    if (previous) {
      const payload = previous.payload;
      if (previous.kind !== kind || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.actorId !== args.actorId || payload.reason !== args.reason) throw new Error('Run control request identity changed');
      return previous;
    }
    const nodes = await tx.taskGraphNode.findMany({ where: { runId: args.runId }, select: { status: true } });
    const status = args.paused ? 'paused' : graphRunBusinessStatus(nodes);
    await tx.taskGraphRun.update({ where: { id: args.runId }, data: { status } });
    return tx.taskGraphEvent.create({ data: { runId: args.runId, kind, idempotencyKey,
      payload: { actorId: args.actorId, reason: args.reason, status } } });
  });
}

/** Runs in the Coordinator that owns the Manager handles, including after restart. */
export async function stopPausedGraphTurns() {
  const runs = await prisma.taskGraphRun.findMany({ where: { status: 'paused' }, include: { nodes: { include: { executions: true } } } });
  for (const run of runs) {
    const taskIds = run.nodes.flatMap(node => [`task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`,
      ...node.executions.flatMap(job => job.childTaskId ? [job.childTaskId] : [])]);
    const turns = await prisma.taskRun.findMany({ where: { taskId: { in: taskIds }, status: { in: ['pending', 'running', 'waiting_for_input'] } }, include: { participants: true } });
    for (const turn of turns) {
      await prisma.taskRun.updateMany({ where: { id: turn.id, status: { in: ['pending', 'running', 'waiting_for_input'] } },
        data: { controlState: 'stop_requested', activityState: 'terminating' } });
      for (const participant of turn.participants) {
        if (['pending', 'running', 'waiting_for_input'].includes(participant.status)) requestRunControl(turn.id, participant.id, 'stop_run');
      }
    }
  }
}
