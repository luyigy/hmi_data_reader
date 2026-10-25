import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { observeTaskRunExit, taskRunExitMatches } from './task-graph/task-run-exit-proof';
import { observeGraphWriter } from './task-graph/writer-ownership';

function metadata(text: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  } catch {}
  return {};
}

function processMayBeAlive(pid: unknown) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}

async function graphOwnsRun(tx: Prisma.TransactionClient, run: { id: string; taskId: string; controlMetadata: string | null }) {
  const owner = metadata(run.controlMetadata);
  if ('graphReview' in owner || 'graphConversation' in owner) return true;
  if (await tx.taskGraphExecution.count({ where: { OR: [{ taskRunId: run.id }, { childTaskId: run.taskId }] } })) return true;
  const reviewNode = /^task-graph-(?:review|architecture)-(.+)$/.exec(run.taskId)?.[1];
  return Boolean(reviewNode && await tx.taskGraphNode.count({ where: { id: reviewNode } }));
}

/** Feishu restart cannot complete graph-owned work. Its coordinator owns recovery, even after writer exit. */
export async function cleanupFeishuOwnedStaleTaskRuns(taskRunId?: string) {
  const candidates = await prisma.taskRun.findMany({ where: { status: 'running', ...(taskRunId ? { id: taskRunId } : {}) }, select: { id: true, taskId: true, taskSessionId: true, controlMetadata: true } });
  for (const candidate of candidates) {
    // graphWriter identifies the process, including for ordinary chat. It is not graph ownership.
    const owner = metadata(candidate.controlMetadata);
    // A live supervisor may still be finalizing after its harness release. Leave it alone.
    if ('graphWriter' in owner && (await observeGraphWriter(owner.graphWriter)).kind !== 'exited') continue;
    const proof = 'graphWriter' in owner ? await observeTaskRunExit(candidate.id) : undefined;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${candidate.taskId} FOR UPDATE`;
      if (candidate.taskSessionId) await tx.$queryRaw`SELECT id FROM "TaskSession" WHERE id = ${candidate.taskSessionId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${candidate.id} FOR UPDATE`;
      const run = await tx.taskRun.findUnique({ where: { id: candidate.id }, include: { participants: { where: { status: 'running' } } } });
      if (!run || run.status !== 'running' || await graphOwnsRun(tx, run)) return;
      const owner = metadata(run.controlMetadata);
      if ('graphWriter' in owner) {
        if (!await taskRunExitMatches(tx, run.id, proof)) return;
        const now = new Date();
        const reason = 'Runtime interrupted before run finalization; previous writer exit confirmed';
        await tx.taskRunParticipant.updateMany({ where: { taskRunId: run.id, status: { in: ['pending', 'running', 'waiting_for_input'] } },
          data: { status: 'interrupted', completedAt: now, error: reason } });
        await tx.taskRun.update({ where: { id: run.id }, data: { status: 'interrupted', activityState: 'stalled', completedAt: now, error: reason } });
        if (run.taskSessionId) await tx.taskSession.updateMany({ where: { id: run.taskSessionId, activeRunId: run.id },
          data: { activeRunId: null, status: 'active', attentionState: 'needs_review', summary: reason } });
        return;
      }
      if (processMayBeAlive(owner.activeLocalHarnessPid) || run.participants.some(participant => processMayBeAlive(metadata(participant.controlMetadata).childPid))) return;
      // Preserve legacy continuation handling only for unowned runs without a known live process.
      for (const participant of run.participants) {
        const details = metadata(participant.controlMetadata);
        const session = typeof details.lastSessionId === 'string' || typeof details.claudeSessionId === 'string' || typeof details.codexThreadId === 'string';
        await tx.taskRunParticipant.updateMany({ where: { id: participant.id, status: 'running', updatedAt: participant.updatedAt }, data: session
          ? { status: 'completed', completedAt: new Date(), error: null }
          : { status: 'failed', completedAt: new Date(), error: 'Stale: process killed before session started' } });
      }
      await tx.taskRun.updateMany({ where: { id: run.id, status: 'running', updatedAt: run.updatedAt }, data: { status: 'completed', completedAt: new Date() } });
    });
  }
}
