import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { graphAssociationForTask } from '../task-graph/graph-association';
import { observeTaskRunExit, taskRunExitMatches, taskRunWriterIdentity, type TaskRunExitProof } from '../task-graph/task-run-exit-proof';

type ResourceRunExitProof = TaskRunExitProof & { ordinaryStatus?: string };

/** Ordinary resource continuations use the runner's terminal state, without graph process scanning. */
export async function observeResourceRunExit(taskRunId: string): Promise<ResourceRunExitProof> {
  const run = await prisma.taskRun.findUnique({ where: { id: taskRunId }, select: { ...taskRunWriterIdentity, status: true } });
  if (!run || await graphAssociationForTask(run.taskId, '')) return observeTaskRunExit(taskRunId);
  const { status, ...identity } = run;
  const terminal = ['completed', 'failed', 'interrupted', 'stopped', 'cancelled'].includes(status);
  return { taskRunId, identity, ordinaryStatus: status,
    observation: terminal ? { kind: 'exited' } : { kind: 'unknown', reason: 'Ordinary run has not finished' } };
}

export async function resourceRunExitMatches(tx: Prisma.TransactionClient, taskRunId: string, proof?: ResourceRunExitProof) {
  if (proof?.ordinaryStatus !== undefined) {
    const run = await tx.taskRun.findUnique({ where: { id: taskRunId }, select: { taskId: true, status: true } });
    if (!run || run.status !== proof.ordinaryStatus || await graphAssociationForTask(run.taskId, '', tx)) return false;
  }
  return taskRunExitMatches(tx, taskRunId, proof);
}

export type { ResourceRunExitProof };
