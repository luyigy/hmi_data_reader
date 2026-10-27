import { prisma } from '../prisma';
import { getContinuationSession } from '../acpx/session-tracking';
import { observeTaskRunExit, taskRunExitMatches } from '../task-graph/task-run-exit-proof';
import { getResourceApproval, lockResourceApproval } from './access';
import { validateResourceAdmission } from './graph-admission';

export async function retryResourceApplication(id: string, revision: number, actorOpenId: string) {
  if (!actorOpenId || actorOpenId !== process.env.FEISHU_ADMIN_OPEN_ID?.trim()) throw new Error('仅管理员可以重试资源接续');
  const before = await getResourceApproval(id);
  const runId = before.payload.application.runId;
  const proof = runId ? await observeTaskRunExit(runId) : undefined;
  return prisma.$transaction(async tx => {
    const approval = await lockResourceApproval(tx, id);
    if (approval.status !== 'approved' || approval.payload.revision !== revision) throw new Error('授权已改变');
    if (['waiting', 'scheduled'].includes(approval.payload.application.state)) return approval;
    if (approval.payload.application.state !== 'failed') throw new Error('当前无需重试');
    const { launch, application } = approval.payload;
    if (launch.graphConversation) throw new Error('旧问答启动已退出；授权仍保留，请在原聊天室继续工作');
    if ((launch.graphExecution || launch.graphReview) && (application.runId || application.eventId)) throw new Error('授权仍然有效，请在原任务卡处理执行恢复');
    if (launch.graphExecution || launch.graphReview) {
      const node = launch.graphReview
        ? await tx.taskGraphNode.findUniqueOrThrow({ where: { id: launch.graphReview.nodeId }, include: { executions: true } })
        : await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: launch.graphExecution!.executionId }, include: { node: { include: { executions: true } } } }).then(job => job.node);
      await validateResourceAdmission(id, node.id, launch.graphExecution ? [launch.graphExecution.executionId] : node.executions.map(job => job.id), tx);
    }
    if (approval.payload.application.runId !== runId) throw new Error('接续运行已改变');
    if (runId) {
      if (!await taskRunExitMatches(tx, runId, proof)) throw new Error('上次执行尚未证明退出');
      const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { participants: true } });
      if (!['failed', 'interrupted', 'stopped'].includes(run.status)) throw new Error('上次运行尚未结束或已完成');
      if (!approval.payload.source && run.participants.length === 1 && getContinuationSession(run.participants[0]).sessionId) {
        approval.payload.source = { taskRunId: run.id, participantId: run.participants[0].id };
      }
      if (await tx.taskRun.count({ where: { taskId: run.taskId, taskSessionId: run.taskSessionId, createdAt: { gt: run.createdAt } } })) throw new Error('原 Session 已有更新的轮次，请使用当前任务');
    }
    approval.payload.applicationHistory = [...approval.payload.applicationHistory || [], approval.payload.application];
    approval.payload.application = { state: 'waiting', detail: `管理员 ${actorOpenId} 请求重试准备与接续` };
    await tx.feishuAdminApproval.update({ where: { id }, data: { payloadJson: JSON.stringify(approval.payload) } });
    return approval;
  });
}
