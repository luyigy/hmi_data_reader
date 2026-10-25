import { prisma } from '../prisma';
import { observeTaskRunWriter } from './writer-ownership';

type Member = { role: string; backend: string | null; harnessType: string | null; runtimeAgentId: string | null; gatewayId: string | null };
type Participant = { role: string; executionBackend: string; harnessType: string; agentId: string | null; gatewayId: string | null };

export function graphRoomParticipantMatches(participant: Participant, member: Member) {
  return participant.role === member.role && participant.executionBackend === member.backend &&
    participant.harnessType === member.harnessType && participant.agentId === member.runtimeAgentId &&
    (member.backend === 'platform_local' || participant.gatewayId === member.gatewayId);
}

export async function graphRoomMemberTaskIds(childTaskId: string) {
  const job = await prisma.taskGraphExecution.findUnique({ where: { childTaskId }, select: { nodeId: true } });
  return job ? [childTaskId, `task-graph-review-${job.nodeId}`, `task-graph-architecture-${job.nodeId}`] : [];
}

export async function graphRoomMemberWriters(childTaskId: string, member: Member) {
  const taskIds = await graphRoomMemberTaskIds(childTaskId);
  const runs = await prisma.taskRun.findMany({ where: { taskId: { in: taskIds },
    participants: { some: { role: member.role, executionBackend: member.backend || '', harnessType: member.harnessType || '', agentId: member.runtimeAgentId } } },
    include: { participants: true } });
  return runs.filter(run => run.participants.some(participant => graphRoomParticipantMatches(participant, member)) &&
    (['pending', 'running', 'waiting_for_input'].includes(run.status) || !!JSON.parse(run.controlMetadata || '{}').graphWriter)).map(run => run.id);
}

/** The reset fence is already persisted. A signal alone is not evidence of writer exit. */
export async function waitForGraphRoomMemberStop(childTaskId: string, member: Member, captured?: string[], timeoutMs = 5_000) {
  const selected = captured || await graphRoomMemberWriters(childTaskId, member);
  const deadline = Date.now() + timeoutMs;
  for (const run of selected) {
    while ((await observeTaskRunWriter(run)).kind !== 'exited') {
      if (Date.now() >= deadline) throw new Error('旧 Agent 写入者尚未确认退出，Session 重置未完成；可重试同一次重置。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
