import { lockSessionActivity, refreshSessionActivity } from '../acpx/session-activity';
import { prisma } from '../prisma';
import { observeResourceRunExit, resourceRunExitMatches } from './run-exit';
import { lockResourceApproval, updateResourceApplication } from './access';

export async function recoverExitedResourceRun(approvalId: string, runId: string) {
  const proof = await observeResourceRunExit(runId);
  if (proof.observation.kind !== 'exited') return false;
  const candidate = await prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
  return prisma.$transaction(async tx => {
    if (candidate.taskSessionId) await lockSessionActivity(tx, candidate.taskId, candidate.taskSessionId);
    const approval = await lockResourceApproval(tx, approvalId);
    if (approval.status !== 'approved' || approval.payload.application.runId !== runId) return false;
    await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${runId} FOR UPDATE`;
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId } });
    if (!['pending', 'running', 'waiting_for_input'].includes(run.status) || !await resourceRunExitMatches(tx, runId, proof)) return false;
    const detail = '接续进程已退出但未提交完成结果；保留授权和现场，可重试接续。';
    await tx.taskRunParticipant.updateMany({ where: { taskRunId: runId, status: { in: ['pending', 'running', 'waiting_for_input'] } }, data: { status: 'interrupted', error: detail, completedAt: new Date() } });
    await tx.taskRun.update({ where: { id: runId }, data: { status: 'interrupted', error: detail, completedAt: new Date() } });
    if (run.taskSessionId) await refreshSessionActivity(tx, run.taskId, run.taskSessionId);
    await updateResourceApplication(approvalId, { ...approval.payload.application, state: 'failed', detail }, tx);
    return true;
  });
}
