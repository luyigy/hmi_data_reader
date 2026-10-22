import type { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { observeTaskRunWriter } from './writer-ownership';

// Status/summary may change when an exited run is interrupted. Writer and session
// identities may not. Observe the OS outside transactions; compare identity inside.
const writerIdentity = {
  id: true, taskId: true, taskSessionId: true, controlMetadata: true, startedAt: true,
  participants: { orderBy: { id: 'asc' }, select: {
    id: true, taskRunId: true, executionBackend: true, gatewayId: true,
    harnessType: true, role: true, agentId: true, controlMetadata: true, startedAt: true,
  } },
} satisfies Prisma.TaskRunSelect;

export async function observeTaskRunExit(taskRunId: string) {
  const identity = await prisma.taskRun.findUnique({ where: { id: taskRunId }, select: writerIdentity });
  const observation = await observeTaskRunWriter(taskRunId);
  return { taskRunId, identity, observation };
}
export type TaskRunExitProof = Awaited<ReturnType<typeof observeTaskRunExit>>;

export async function taskRunExitMatches(tx: Prisma.TransactionClient, taskRunId: string, proof?: TaskRunExitProof) {
  if (!proof || proof.taskRunId !== taskRunId || !proof.identity || proof.observation.kind !== 'exited') return false;
  return isDeepStrictEqual(proof.identity, await tx.taskRun.findUnique({ where: { id: taskRunId }, select: writerIdentity }));
}
