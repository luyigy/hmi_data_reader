import { prisma } from '../prisma';
import { parseAcpxMetadata, getContinuationSession } from '../acpx/session-tracking';
import { HistoryReference, normalizeNativeId } from './types';
const active = ['pending', 'running', 'waiting_for_input'];

export async function historyReferences(scope?: { harness: string; nativeId: string }): Promise<HistoryReference[]> {
  const participants = await prisma.taskRunParticipant.findMany({
    where: { executionBackend: 'platform_local', ...(scope ? { harnessType: scope.harness, controlMetadata: { contains: scope.nativeId } } : {}) }, take: 100001,
    select: { id: true, harnessType: true, controlMetadata: true, status: true, lastActivityAt: true, startedAt: true, completedAt: true, createdAt: true,
      taskRun: { select: { id: true, taskId: true, taskSessionId: true, status: true, lastActivityAt: true, completedAt: true,
        taskSession: { select: { status: true, attentionState: true } }, task: { select: { name: true, status: true, currentTaskSessionId: true, taskGraphExecutions: { select: { status: true } } } } } } },
  });
  if (participants.length > 100000) throw new Error('平台引用超过扫描上限，禁止清理');
  const references: HistoryReference[] = participants.flatMap(p => {
    const metadata = parseAcpxMetadata(p.controlMetadata);
    const id = getContinuationSession(p).sessionId;
    if (!id || metadata.historyDeletedAt) return [];
    const run = p.taskRun;
    const reasons: string[] = [];
    if (run.task.taskGraphExecutions.some(execution => execution.status !== 'integrated')) reasons.push('任务图执行尚未完成集成');
    if (active.includes(p.status) || active.includes(run.status)) reasons.push('运行中或等待输入');
    if (run.taskSessionId && run.task.currentTaskSessionId === run.taskSessionId) reasons.push('仍绑定为任务当前会话');
    if (run.taskSession?.status === 'paused' || run.taskSession?.status === 'waiting_user'
      || (run.taskSession?.attentionState && run.taskSession.attentionState !== 'normal')) reasons.push('等待恢复、审批或处理');
    const lastActivity = Math.max(...[p.createdAt, p.startedAt, p.completedAt, p.lastActivityAt, run.lastActivityAt, run.completedAt].flatMap(v => v ? [v.getTime()] : []));
    return [{ nativeId: normalizeNativeId(p.harnessType, id), harness: p.harnessType, participantId: p.id,
      taskId: run.taskId, taskName: run.task.name, lastActivity, protected: reasons.length > 0, reasons }];
  });
  const sessions = await prisma.liveRoomMemberSession.findMany({
    where: { backend: 'platform_local', threadId: scope ? { in: [scope.nativeId, `session_${scope.nativeId}`] } : { not: null },
      ...(scope ? { member: { harnessType: scope.harness } } : {}) }, take: 10001,
    select: { id: true, threadId: true, lastDeliveredAt: true, createdAt: true, member: { select: { harnessType: true } }, room: { select: { id: true, title: true, sourceTaskId: true } } },
  });
  if (sessions.length > 10000) throw new Error('聊天室引用超过扫描上限，禁止清理');
  for (const session of sessions) if (session.threadId && session.member.harnessType) references.push({
    nativeId: normalizeNativeId(session.member.harnessType, session.threadId), harness: session.member.harnessType,
    participantId: 'room:' + session.id, taskId: session.room.sourceTaskId || 'room:' + session.room.id, taskName: session.room.title,
    lastActivity: (session.lastDeliveredAt || session.createdAt).getTime(), protected: true, reasons: ['仍有聊天室原生会话绑定'],
  });
  return references;
}
export async function revokeHistoryReferences(harness: string, nativeId: string, operationId: string) {
  await prisma.$transaction(async tx => {
    const rows = await tx.taskRunParticipant.findMany({ where: { executionBackend: 'platform_local', harnessType: harness, controlMetadata: { contains: nativeId } }, select: { id: true, controlMetadata: true } });
    for (const row of rows) {
      const metadata = parseAcpxMetadata(row.controlMetadata);
      const id = getContinuationSession({ ...row, harnessType: harness }).sessionId;
      if (!id || normalizeNativeId(harness, id) !== nativeId) continue;
      const changed = await tx.taskRunParticipant.updateMany({ where: { id: row.id, controlMetadata: row.controlMetadata }, data: { controlMetadata: JSON.stringify({
        ...metadata, continuationStaleAt: new Date().toISOString(), continuationStaleReason: 'history_cleanup', historyDeletedAt: new Date().toISOString(), historyCleanupOperationId: operationId,
      }) } });
      if (changed.count !== 1) throw new Error('会话引用在清理期间变化，需重新核对');
    }
  }, { timeout: 30000 });
}
export async function assertNoActiveHarness(harness: string) {
  const activeCount = await prisma.taskRunParticipant.count({ where: { executionBackend: 'platform_local', harnessType: harness,
    OR: [{ status: { in: active } }, { taskRun: { status: { in: active } } }] } });
  if (activeCount) throw new Error('该工具还有运行或排队任务，结束后再确认清理');
}
