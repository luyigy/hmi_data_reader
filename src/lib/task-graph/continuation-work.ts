import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { graphGit } from './git-command';

/** Saved code, material receipts and human inputs count; prose, tool requests and fresh Turn IDs do not. */
export async function continuationWorkFingerprint(executionId: string, candidateCommit: string) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
  const events = await prisma.taskGraphEvent.findMany({ where: { nodeId: job.nodeId,
    kind: { in: ['conversation_input', 'project_material_query', 'project_material_added'] } }, select: { id: true, kind: true, payload: true } });
  const facts = events.flatMap(event => {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.executionId !== executionId) return [];
    if (event.kind === 'conversation_input') return ['input:' + (typeof payload.rootInputId === 'string' ? payload.rootInputId : event.id)];
    if (typeof payload.responseHash === 'string') return ['material:' + payload.responseHash];
    if (typeof payload.sha256 === 'string') return ['image:' + payload.sha256];
    return [];
  });
  // Tool events contain request previews, not verified observations. Per-turn output paths
  // make repeated failed probes look distinct and would disable the no-progress bound.
  const tree = await graphGit(job.repository, 'rev-parse', '--verify', `${candidateCommit}^{tree}`);
  return createHash('sha256').update(JSON.stringify([tree, Array.from(new Set(facts)).sort()])).digest('hex');
}
