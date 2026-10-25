import { prisma } from '../prisma';
import { observeTaskRunExit, taskRunExitMatches } from '../task-graph/task-run-exit-proof';
import { lockResourceApproval, updateResourceApplication } from './access';

export async function recoverExitedResourceRun(approvalId: string, runId: string) {
  const proof = await observeTaskRunExit(runId);
  if (proof.observation.kind !== 'exited') return false;
  return prisma.$transaction(async tx => {
    const approval = await lockResourceApproval(tx, approvalId);
    if (approval.status !== 'approved' || approval.payload.application.runId !== runId) return false;
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${runId} FOR UPDATE`;
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId } });
    if (!['pending', 'running', 'waiting_for_input'].includes(run.status) || !await taskRunExitMatches(tx, runId, proof)) return false;
    const detail = '接续进程已退出但未提交完成结果；保留授权和现场，可重试接续。';
    await tx.taskRunParticipant.updateMany({ where: { taskRunId: runId, status: { in: ['pending', 'running', 'waiting_for_input'] } }, data: { status: 'interrupted', error: detail, completedAt: new Date() } });
    await tx.taskRun.update({ where: { id: runId }, data: { status: 'interrupted', error: detail, completedAt: new Date() } });
    if (run.taskSessionId) await tx.taskSession.updateMany({ where: { id: run.taskSessionId, activeRunId: runId }, data: { activeRunId: null, attentionState: 'needs_review' } });
    await updateResourceApplication(approvalId, { ...approval.payload.application, state: 'failed', detail }, tx);
    return true;
  });
}
