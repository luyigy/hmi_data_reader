import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { graphGit } from './git-command';

/** Saved code, material receipts, human inputs and distinct observed tool work count; model prose and fresh Turn IDs do not. */
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
  // Investigation can span turns before producing a code change. Repeating the same
  // tool preview is not new work, regardless of the event or process identity.
  if (job.childTaskId) {
    const tools = await prisma.taskRunEvent.findMany({ where: { taskRun: { taskId: job.childTaskId }, eventType: 'control_message' },
      select: { content: true, metadata: true } });
    for (const tool of tools) {
      try {
        const metadata: unknown = JSON.parse(tool.metadata || 'null');
        if (metadata && typeof metadata === 'object' && 'kind' in metadata && metadata.kind === 'tool') facts.push('tool:' + tool.content);
      } catch { /* Legacy events without structured tool metadata do not establish tool work. */ }
    }
  }
  const tree = await graphGit(job.repository, 'rev-parse', '--verify', `${candidateCommit}^{tree}`);
  return createHash('sha256').update(JSON.stringify([tree, Array.from(new Set(facts)).sort()])).digest('hex');
}
