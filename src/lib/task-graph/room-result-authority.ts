import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { verificationInputs } from './domain';
import { executionProgress } from './execution-progress';
import { completedRoomSource } from './result-source';
import type { ResultBinding } from './task-run-result';
import { observeTaskRunWriter } from './writer-ownership';

/** Publication authority comes from the server-bound TaskRun, never a made-up scheduler claim. */
export async function assertRoomResultAuthority(tx: Prisma.TransactionClient, taskRunId: string, nodeId: string) {
  const turn = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
  const binding = JSON.parse(turn.controlMetadata || '{}').graphResultBinding as ResultBinding | undefined;
  if (!binding || binding.source !== 'room' || !binding.authorized || binding.taskRunId !== taskRunId ||
      binding.taskId !== turn.taskId || binding.nodeId !== nodeId) throw new Error('Room result has no registered publication authority');
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId }, include: { executions: true, run: true } });
  if (node.runId !== binding.runId || createHash('sha256').update(JSON.stringify(node.run.snapshot)).digest('hex') !== binding.snapshotHash) throw new Error('Room result approved snapshot changed');
  const revisions = node.executions.map(job => ({ executionId: job.id, revision: executionProgress(job.dispatchMetadata)?.revision || 0 })).sort((a, b) => a.executionId.localeCompare(b.executionId));
  if (!isDeepStrictEqual(revisions, binding.revisions) || !isDeepStrictEqual(verificationInputs(node.executions), binding.inputs)) throw new Error('Room result candidate changed; retain historical result without publication');
  if ((await observeTaskRunWriter(taskRunId, tx)).kind !== 'exited') throw new Error('Room result writer has not exited');
  const completion = await completedRoomSource(tx, taskRunId);
  if (!isDeepStrictEqual(completion.sources.map(source => source.executionId).sort(), [...binding.executionIds].sort())) throw new Error('Room result source set does not match its executions');
  return { binding, node, completion };
}
