import { prisma } from '../prisma';
import { requestRunControl } from '../acpx/process-registry';
import { observeTaskRunWriter } from '../task-graph/writer-ownership';
import { admitNode } from '../task-graph/preparation-recovery';
import { executeAcpxTaskRun } from '../acpx/runner';
import { getResourceApproval, resolveResourceAccess, updateResourceApplication } from './access';
import { recoverExitedResourceRun } from './recovery';
import { resourceContinuationLaunch } from './runtime';
import type { ResourceApproval } from './model';

const active = new Map<string, Promise<void>>();

async function publish(id: string) {
  const { publishResourceApproval } = await import('./cards');
  await publishResourceApproval(id).catch(error => console.warn('[Resources] card update failed:', error instanceof Error ? error.message : String(error)));
}

async function revoke(approval: ResourceApproval) {
  const runs = await prisma.taskRun.findMany({ where: { controlMetadata: { contains: approval.id } } });
  let stopped = true;
  for (const run of runs) {
    const ids: unknown = JSON.parse(run.controlMetadata || '{}').resources?.approvalIds;
    if (!Array.isArray(ids) || !ids.includes(approval.id)) continue;
    if ((await observeTaskRunWriter(run.id)).kind === 'exited') continue;
    stopped = false;
    await prisma.taskRun.update({ where: { id: run.id }, data: { controlState: 'stop_requested', activityState: 'terminating' } });
    const participants = await prisma.taskRunParticipant.findMany({ where: { taskRunId: run.id } });
    for (const participant of participants) requestRunControl(run.id, participant.id, 'stop_run');
  }
  if (stopped) await updateResourceApplication(approval.id, { ...approval.payload.application, state: 'revoked' });
  await publish(approval.id);
}

async function reconcileOne(id: string) {
  const approval = await getResourceApproval(id);
  const { payload } = approval;
  if (approval.status === 'revoked') {
    if (payload.application.state !== 'revoked') await revoke(approval);
    return;
  }
  if (approval.status === 'pending') {
    if (!approval.cardMessageId) await publish(id);
    return;
  }
  if (approval.status !== 'approved' || payload.application.state === 'failed') return;
  if (payload.application.state === 'scheduled' && payload.application.eventId && !payload.application.runId) return;
  if (payload.application.runId) {
    const run = await prisma.taskRun.findUnique({ where: { id: payload.application.runId } });
    if (run && ['pending', 'running', 'waiting_for_input'].includes(run.status) && !payload.launch.graphExecution && !payload.launch.graphReview &&
        await recoverExitedResourceRun(id, run.id)) await publish(id);
    if (run && ['failed', 'interrupted', 'stopped'].includes(run.status)) {
      await updateResourceApplication(id, { ...payload.application, state: 'failed', detail: run.error || run.summary || '接续执行失败，保留原会话与目录' });
      await publish(id);
    }
    if (run?.status === 'completed' && payload.application.state === 'effective' && payload.application.detail !== '本轮已结束，后续会话可沿用授权。') {
      await updateResourceApplication(id, { ...payload.application, detail: '本轮已结束，后续会话可沿用授权。' });
      await publish(id);
    }
    return;
  }
  try {
    await resolveResourceAccess(payload.launch);
    if (payload.source) {
      const source = await prisma.taskRun.findUniqueOrThrow({ where: { id: payload.source.taskRunId } });
      if (['pending', 'running', 'waiting_for_input'].includes(source.status) || (await observeTaskRunWriter(source.id)).kind !== 'exited') return;
    }
    const launch = await resourceContinuationLaunch(approval);
    if (launch.graphExecution || launch.graphReview) {
      const node = launch.graphReview
        ? await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: launch.graphReview.nodeId }, include: { executions: true } })
        : await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: launch.graphExecution!.executionId }, include: { node: { include: { executions: true } } } }).then(job => job.node);
      const ids = launch.graphExecution ? [launch.graphExecution.executionId] : node.executions.map(job => job.id);
      const result = await admitNode(node.id, { source: 'resource_approval', id, executionIds: ids });
      if (result.kind === 'deferred' || result.kind === 'rejected') {
        await updateResourceApplication(id, { ...payload.application, state: result.kind === 'deferred' ? 'waiting' : 'failed',
          detail: result.reason === 'retry_not_due' ? payload.application.detail || '等待准备重试时间。' : result.reason });
      }
      await publish(id);
      return;
    }
    if (launch.graphConversation) throw new Error('旧问答启动已退出；授权仍保留，请在原聊天室继续工作');
    const result = await executeAcpxTaskRun(launch);
    const current = await getResourceApproval(id);
    if (current.status !== 'approved') return;
    if (result.status !== 'completed') await updateResourceApplication(id, { ...current.payload.application, state: 'failed', detail: result.summary || '原会话接续失败' });
    else await updateResourceApplication(id, { ...current.payload.application, detail: '本轮已结束，后续会话可沿用授权。' });
    await publish(id);
  } catch (error) {
    const current = await getResourceApproval(id);
    if (current.status !== 'approved' || current.payload.application.runId && current.payload.application.runId !== payload.application.runId) return;
    await updateResourceApplication(id, { ...current.payload.application, state: 'failed', detail: error instanceof Error ? error.message : String(error) });
    await publish(id);
  }
}

export async function reconcileResourceApprovals(id?: string): Promise<void> {
  const rows = id ? [{ id }] : await prisma.feishuAdminApproval.findMany({
    where: { kind: 'task_resources', status: { in: ['pending', 'approved', 'revoked'] } }, select: { id: true },
  });
  for (const row of rows) {
    if (active.has(row.id)) continue;
    const operation = reconcileOne(row.id).catch(error => console.warn('[Resources] reconciliation failed:', error instanceof Error ? error.message : String(error)))
      .finally(() => active.delete(row.id));
    active.set(row.id, operation);
  }
}

export async function drainResourceApprovals() { await Promise.all(Array.from(active.values())); }
