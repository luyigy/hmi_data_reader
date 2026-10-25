import { prepareResourceWorkspaces } from './graph-workspace';
import type { TaskInputManifest } from '../task-graph/upstream-inputs';
import { realpath } from 'node:fs/promises';
import { observeResourceWriters, reserveResourceWriters } from './writer-boundary';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { getContinuationSession } from '../acpx/session-tracking';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../acpx/permissions';
import { observeTaskRunExit, taskRunExitMatches, type TaskRunExitProof } from '../task-graph/task-run-exit-proof';
import type { AcpxRunRequest } from '../acpx/types';
import { getResourceApproval, lockResourceApproval, resolveResourceAccess, updateResourceApplication } from './access';
import { directoryContains, resourcePrincipal, verifyResourceDirectories, type ResourceApproval } from './model';

export async function resourceContinuationLaunch(approval: ResourceApproval, current: AcpxRunRequest = approval.payload.launch): Promise<AcpxRunRequest> {
  const { payload } = approval;
  if (approval.status !== 'approved' || ['revoked', 'revoking'].includes(payload.application.state)) throw new Error('资源授权已失效');
  if (current.taskId !== payload.launch.taskId || JSON.stringify(resourcePrincipal(current)) !== JSON.stringify(resourcePrincipal(payload.launch))) throw new Error('资源接续目标已改变');
  if (current.workingDirectory !== payload.launch.workingDirectory) throw new Error('资源接续必须保留原工作目录');
  const task = await prisma.task.findUniqueOrThrow({ where: { id: current.taskId } });
  if (['paused', 'cancelled', 'completed'].includes(task.status)) throw new Error('任务已暂停或结束，资源批准不恢复任务');
  if (payload.launch.taskSessionId && task.currentTaskSessionId !== payload.launch.taskSessionId) throw new Error('原任务 Session 已改变，不能转投资源批准');
  let participant = payload.launch.participants[0];
  if (payload.source) {
    const original = await prisma.taskRunParticipant.findUniqueOrThrow({ where: { id: payload.source.participantId }, include: { taskRun: true } });
    if (original.taskRunId !== payload.source.taskRunId || original.taskRun.taskId !== current.taskId || original.taskRun.taskSessionId !== payload.launch.taskSessionId ||
        original.role !== participant.role || original.harnessType !== participant.harnessType || original.executionBackend !== participant.executionBackend ||
        original.gatewayId !== participant.gatewayId || original.agentId !== (participant.agentId || null)) throw new Error('原资源申请会话身份不一致');
    if (['stop_requested', 'interrupt_requested'].includes(original.taskRun.controlState)) throw new Error('原执行已被用户停止，请通过原任务继续入口恢复');
    const native = getContinuationSession(original);
    if (!native.sessionId) throw new Error('原生 Session 不可恢复，保留现场，不创建替代会话');
    participant = { ...participant, resumeSessionId: native.sessionId, continuationSessionKind: native.sessionKind || undefined,
      resumeThreadId: native.sessionKind === 'codex_thread' ? native.sessionId : undefined,
      continuationMessage: '补充资源授权已批准并应用，继续原任务。保持原职责，使用本轮列出的获准目录。' };
  }
  await resolveResourceAccess({ ...current, participants: [participant] });
  return { ...current, taskSessionId: payload.launch.taskSessionId, participants: [participant],
    resourceContinuation: { approvalId: approval.id, revision: payload.revision } };
}

export async function attachScheduledResourceContinuation(request: AcpxRunRequest): Promise<AcpxRunRequest> {
  if (request.resourceContinuation) return resourceContinuationLaunch(await getResourceApproval(request.resourceContinuation.approvalId), request);
  if (!request.graphExecution && !request.graphReview) return request;
  const rows = await prisma.feishuAdminApproval.findMany({ where: { kind: 'task_resources', status: 'approved' }, orderBy: { createdAt: 'asc' } });
  for (const row of rows) {
    const approval = await getResourceApproval(row.id);
    const { payload } = approval;
    if (payload.application.state !== 'scheduled' || payload.application.runId || payload.launch.taskId !== request.taskId) continue;
    if (request.graphExecution && payload.launch.graphExecution?.executionId !== request.graphExecution.executionId ||
        request.graphReview && (payload.launch.graphReview?.nodeId !== request.graphReview.nodeId || payload.launch.graphReview.phase !== request.graphReview.phase)) continue;
    return resourceContinuationLaunch(approval, request);
  }
  return request;
}

export async function resourceContinuationExit(request: AcpxRunRequest) {
  if (!request.resourceContinuation) return;
  const approval = await getResourceApproval(request.resourceContinuation.approvalId);
  return approval.payload.source ? observeTaskRunExit(approval.payload.source.taskRunId) : undefined;
}

export async function reserveResourceContinuation(tx: Prisma.TransactionClient, request: AcpxRunRequest, runId: string, proof?: TaskRunExitProof) {
  if (!request.resourceContinuation) return;
  const approval = await lockResourceApproval(tx, request.resourceContinuation.approvalId);
  if (approval.status !== 'approved' || approval.payload.revision !== request.resourceContinuation.revision ||
      approval.payload.application.runId || !['waiting', 'scheduled', 'failed'].includes(approval.payload.application.state)) throw new Error('资源接续已派发或授权已改变');
  if (approval.payload.launch.taskId !== request.taskId || approval.payload.launch.taskSessionId && approval.payload.launch.taskSessionId !== request.taskSessionId) throw new Error('资源接续 Session 归属改变');
  const session = await tx.taskSession.findUniqueOrThrow({ where: { id: request.taskSessionId! } });
  if (session.status === 'paused') throw new Error('原 Session 已暂停');
  if (approval.payload.source && ['stop_requested', 'interrupt_requested'].includes((await tx.taskRun.findUniqueOrThrow({ where: { id: approval.payload.source.taskRunId } })).controlState)) throw new Error('原执行已被用户停止');
  if (approval.payload.source && !await taskRunExitMatches(tx, approval.payload.source.taskRunId, proof)) throw new Error('原执行的退出证明已改变');
  const active = await tx.taskRun.count({ where: { taskId: request.taskId, taskSessionId: request.taskSessionId,
    id: { not: runId }, status: { in: ['pending', 'running', 'waiting_for_input'] } } });
  if (active) throw new Error('原 Session 仍有运行中的任务');
  if (!approval.payload.launch.taskSessionId) {
    approval.payload.launch.taskSessionId = request.taskSessionId;
    await tx.feishuAdminApproval.update({ where: { id: approval.id }, data: { payloadJson: JSON.stringify(approval.payload) } });
  }
  await updateResourceApplication(approval.id, { ...approval.payload.application, state: 'scheduled', runId }, tx);
}

export async function resourcesForRun(request: AcpxRunRequest, taskRunId: string, participantId: string, manifests: TaskInputManifest[] = []) {
  const resolved = request.participants[0]?.harnessType === 'codex' ? await resolveResourceAccess(request) : { approvalIds: [], resources: [] };
  const permission = request.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG;
  const read = resolved.resources.filter(item => item.access === 'read').map(item => item.canonicalPath);
  const mapped = await prepareResourceWorkspaces(request, resolved.resources, manifests);
  const write = mapped.write;
  if (permission.sandboxMode === 'read-only' && write.length) throw new Error('只读角色不能继承源码写入授权');
  const workspace = permission.writableRoots[0] || request.workingDirectory;
  const existingRead = await Promise.all((request.extraReadOnlyPaths || []).map(p => realpath(p).catch(() => p)));
  const existingWrite = await Promise.all((permission.sandboxMode === 'read-only' ? [] : [...permission.writableRoots, workspace || process.cwd()]).map(p => realpath(p)));
  for (const root of read) if (existingWrite.some(w => directoryContains(root, w))) throw new Error('只读资源会覆盖当前可写工作区，需调整目录范围');
  for (const root of write) if (read.some(r => directoryContains(root, r) || directoryContains(r, root)) || existingRead.some(r => directoryContains(r, root))) throw new Error('补充目录读写范围重叠，需明确独立目录');
  {
    const proofs = existingWrite.length || write.length ? await observeResourceWriters(taskRunId, existingWrite, write) : [];
    await prisma.$transaction(async tx => {
      if (existingWrite.length || write.length) await reserveResourceWriters(tx, taskRunId, participantId, existingWrite, write, proofs);
      const authorizations = [];
      for (const id of resolved.approvalIds.slice().sort()) {
        const approval = await lockResourceApproval(tx, id);
        if (approval.status !== 'approved') throw new Error('资源授权已撤销，禁止挂载');
        await verifyResourceDirectories(approval.payload.resources);
        authorizations.push({ approvalId: id, revision: approval.payload.revision, source: approval.payload.source, approvedClaim: approval.payload.launch.graphExecution?.claimToken, currentClaim: request.graphExecution?.claimToken, taskSessionId: request.taskSessionId, expectedNativeSessionId: request.participants[0]?.resumeSessionId || request.participants[0]?.resumeThreadId });
      }
      await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${taskRunId} FOR UPDATE`;
      const run = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
      const participant = await tx.taskRunParticipant.findUniqueOrThrow({ where: { id: participantId } });
      const resources = { approvalIds: resolved.approvalIds, readOnlyRoots: read, writableRoots: write, mappings: mapped.mappings, authorizations };
      const metadata = JSON.parse(run.controlMetadata || '{}');
      const used = { ...resources, approvalIds: Array.from(new Set([...(metadata.resources?.approvalIds || []), ...resolved.approvalIds])) };
      await tx.taskRun.update({ where: { id: run.id }, data: { controlMetadata: JSON.stringify({ ...metadata, resources: used }) } });
      await tx.taskRunParticipant.update({ where: { id: participant.id }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(participant.controlMetadata || '{}'), resources }) } });
    });
  }
  return { read, write, protectedPaths: mapped.protectedPaths, approvalIds: resolved.approvalIds,
    instructions: mapped.instructions + (resolved.resources.length ? '\n本轮补充授权目录：\n' + resolved.resources.map(item => { const mapping = mapped.mappings.find(entry => entry.repository === item.canonicalPath); return mapping ? `读写 ${mapping.checkout}（授权来源 ${item.canonicalPath}，原目录只读）` : `${item.access === 'write' ? '读写' : '只读'} ${item.canonicalPath}`; }).join('\n') : '') };
}

export async function markResourceRunEffective(request: AcpxRunRequest, taskRunId: string, nativeSessionId: string) {
  const reservation = request.resourceContinuation;
  if (!reservation) return;
  const expected = request.participants[0]?.resumeSessionId || request.participants[0]?.resumeThreadId;
  if (expected && nativeSessionId !== expected) throw new Error('接续返回了不同的原生 Session，拒绝改绑');
  await prisma.$transaction(async tx => {
    const approval = await lockResourceApproval(tx, reservation.approvalId);
    if (approval.status !== 'approved' || approval.payload.revision !== reservation.revision || approval.payload.application.runId !== taskRunId) throw new Error('资源授权在启动时已改变');
    await updateResourceApplication(approval.id, { ...approval.payload.application, state: 'effective' }, tx);
  });
}
