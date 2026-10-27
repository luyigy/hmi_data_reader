import type { TaskGraphExecution } from '@prisma/client';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { parseInputManifest, type TaskInput } from './input-manifest';

/** A completed dependency delivers the supplemental versions it actually consumed. */
export async function inheritDeliveredInputs(runId: string, jobs: (TaskGraphExecution & { nodeKey: string; quality: string })[], primaryRepository: string, inputs: TaskInput[]) {
  const result = inputs.map(input => ({ ...input }));
  for (const job of jobs) {
    const pin = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: {
      runId, idempotencyKey: `execution:${job.id}:inputs:${job.claimToken || 'legacy'}` } } });
    if (!pin) continue;
    const manifest = parseInputManifest(pin.payload);
    if (manifest.executionId !== job.id) throw new Error('前置交付的固定输入身份不一致');
    for (const input of manifest.inputs.filter(item => item.replacement && item.repository !== primaryRepository)) {
      const inherited = { ...input, executions: [`${job.nodeKey}/${job.key}`], quality: [job.quality] };
      const index = result.findIndex(item => item.repository === input.repository);
      if (index === -1) { result.push(inherited); continue; }
      const previous = result[index];
      if (previous.commit === input.commit) continue;
      if (await graphGit(input.repository, 'merge-base', '--is-ancestor', previous.commit, input.commit).then(() => true, () => false)) {
        result[index] = inherited;
      } else if (!await graphGit(input.repository, 'merge-base', '--is-ancestor', input.commit, previous.commit).then(() => true, () => false)) {
        throw new Error(`前置交付使用了不同的补充输入版本：${input.repository} ${previous.commit} / ${input.commit}`);
      }
    }
  }
  return result;
}
