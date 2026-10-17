import { prisma } from '../prisma';
import { redactSensitiveText } from '../redact-sensitive';
import { taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';
import { confirmExistingIssueAdoption } from './issue-adoption';
import { assertSpecPackage } from './spec-package';
import { postGraphParentProgress } from './feishu';

const retryAt = new Map<string, number>();

/** Keep provider round trips outside the short Feishu callback; processing is durable across restarts. */
export async function processPendingIssueAdoptions() {
  const proposals = await prisma.taskGraphProposal.findMany({ where: { status: 'processing', decidedBy: { not: null } }, orderBy: { decidedAt: 'asc' }, take: 20 });
  for (const proposal of proposals) {
    const raw = proposal.definition as unknown as GraphDefinition;
    if (!raw.adoptRun || (retryAt.get(proposal.id) || 0) > Date.now()) continue;
    retryAt.set(proposal.id, Date.now() + 30_000);
    try {
      const definition = validateTaskGraphDefinition(raw);
      if (taskGraphSnapshotHash(definition) !== proposal.snapshotHash) throw new Error('关联快照已变化，请重新提审');
      await assertSpecPackage(definition.specPackage);
      await confirmExistingIssueAdoption({ definition, proposalId: proposal.id, actorId: proposal.decidedBy!, parentTaskId: proposal.parentTaskId });
      await prisma.taskGraphProposal.updateMany({ where: { id: proposal.id, status: 'processing', snapshotHash: proposal.snapshotHash }, data: { status: 'confirmed' } });
      await postGraphParentProgress(proposal.parentTaskId, proposal.id, '现有任务已关联 Issues。已完成结果、待补材料、原话题和分工保持；未重跑或放行任务。')
        .catch((error) => console.error('[TaskGraph] association progress delivery failed:', error));
      retryAt.delete(proposal.id);
    } catch (error) {
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      const transient = /API .*failed|ETIMEDOUT|ECONN|network/i.test(detail);
      if (!transient) {
        await prisma.taskGraphProposal.updateMany({ where: { id: proposal.id, status: 'processing' }, data: { status: 'pending', decidedBy: null, decidedAt: null } });
        retryAt.delete(proposal.id);
      }
      await postGraphParentProgress(proposal.parentTaskId, proposal.id + ':issue-adoption-failed',
        `Issue 关联尚未完成：${detail}。现有任务进度保持。${transient ? '平台稍后重查，无需重启实施。' : '请重新核对来源并提审。'}`)
        .catch((deliveryError) => console.error('[TaskGraph] association failure delivery failed:', deliveryError));
    }
  }
}
