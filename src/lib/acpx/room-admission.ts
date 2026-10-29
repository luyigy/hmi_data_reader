import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { buildLiveRoomAcpxParticipant } from '../live-room-members';
import { extractRemoteHostIdFromRoleLabel } from '../live-room-types';
import { assertWorkspaceWriterAvailable } from '../task-graph/writer-admission';
import { getContinuationSession, parseAcpxMetadata } from './session-tracking';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from './permissions';
import type { AcpxRunRequest } from './types';

import { activeRunStatuses } from './session-activity';
export interface RoomRunBinding {
  deliveryId: string; messageId: string; memberId: string; roomId: string;
  retryOfRunId: string | null;
}

/** The caller holds the workspace admission lock and Task/TaskSession row locks. */
export async function bindRoomAdmission(tx: Prisma.TransactionClient, request: AcpxRunRequest): Promise<RoomRunBinding | undefined> {
  if (!request.roomDelivery) return;
  if (request.graphAssociation || request.graphExecution || request.graphReview) throw new Error('Room admission cannot replace graph authority');
  await tx.$queryRaw`SELECT id FROM "LiveRoomDelivery" WHERE id = ${request.roomDelivery.deliveryId} FOR UPDATE`;
  const delivery = await tx.liveRoomDelivery.findUniqueOrThrow({ where: { id: request.roomDelivery.deliveryId }, include: {
    targetMember: { include: { agentRecord: true } }, session: true, roomMessage: { include: { room: true } },
  } });
  const member = delivery.targetMember, room = delivery.roomMessage.room;
  const task = await tx.task.findUniqueOrThrow({ where: { id: request.taskId } });
  if (room.sourceTaskId !== request.taskId || member.roomId !== room.id || !member.canReply || member.joinStatus !== 'joined'
    || delivery.session?.memberId !== member.id || delivery.session.roomId !== room.id
    || (!request.resourceContinuation && !['pending', 'running'].includes(delivery.deliveryStatus)) || task.currentTaskSessionId !== request.taskSessionId) {
    throw new Error('Invalid live room delivery binding');
  }
  const expected = buildLiveRoomAcpxParticipant({ ...member,
    gatewayId: member.backend === 'remote_ssh' ? extractRemoteHostIdFromRoleLabel(member.roleLabel) || member.gatewayId : member.gatewayId,
    runtimeAgentId: member.runtimeAgentId || member.agentRecord?.runtimeAgentId,
  });
  const participant = request.participants[0];
  if (request.participants.length !== 1 || !participant ||
    (['gatewayId', 'executionBackend', 'harnessType', 'agentId', 'role', 'continuationKey'] as const)
      .some(key => (participant[key] || null) !== (expected[key] || null))) throw new Error('Room participant does not match trusted delivery');
  const resume = participant.resumeSessionId || participant.resumeThreadId;
  if (participant.resumeSessionId && participant.resumeThreadId && participant.resumeSessionId !== participant.resumeThreadId) throw new Error('Conflicting native resume identities');
  if (resume) {
    const source = request.roomDelivery.resumeSourceParticipantId ? await tx.taskRunParticipant.findUnique({
      where: { id: request.roomDelivery.resumeSourceParticipantId }, include: { taskRun: true },
    }) : null;
    if (!source || (source.status !== 'completed' && !(request.resourceContinuation && source.status === 'failed')) || source.taskRun.taskId !== task.id || source.taskRun.taskSessionId !== request.taskSessionId
      || (!request.resourceContinuation && ['failed', 'stopped'].includes(source.taskRun.status)) || parseAcpxMetadata(source.controlMetadata).continuationStaleAt
      || parseAcpxMetadata(source.controlMetadata).continuationKey !== expected.continuationKey
      || source.gatewayId !== participant.gatewayId || source.executionBackend !== participant.executionBackend
      || source.harnessType !== participant.harnessType || source.agentId !== (participant.agentId || null)
      || getContinuationSession(source).sessionId !== resume) throw new Error('Native resume identity is not owned by the room member');
  }
  const binding: RoomRunBinding = { deliveryId: delivery.id, messageId: request.resourceContinuation
    ? `${delivery.roomMessageId}:resource:${request.resourceContinuation.approvalId}:${request.resourceContinuation.revision}` : delivery.roomMessageId, memberId: member.id,
    roomId: room.id, retryOfRunId: request.roomDelivery.retryOfRunId || null };
  const history = await tx.taskRun.findMany({ where: { taskId: task.id }, select: { id: true, status: true, controlMetadata: true } });
  const sameRequest = history.filter(run => {
    const prior = parseAcpxMetadata(run.controlMetadata).roomAdmission as RoomRunBinding | undefined;
    return prior?.memberId === member.id && prior.messageId === binding.messageId;
  });
  if (sameRequest.some(run => (parseAcpxMetadata(run.controlMetadata).roomAdmission as RoomRunBinding).retryOfRunId === binding.retryOfRunId)) {
    throw new Error('Room request already admitted');
  }
  if (binding.retryOfRunId && !sameRequest.some(run => run.id === binding.retryOfRunId && run.status === 'failed')) {
    throw new Error('Room retry must follow its own failed attempt');
  }
  return binding;
}

const host = (p: { executionBackend: string; gatewayId?: string | null }) =>
  p.executionBackend === 'platform_local' ? 'local' : `${p.executionBackend}:${p.gatewayId}`;
const overlap = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : b + '/') || b.startsWith(a.endsWith('/') ? a : a + '/');
async function canonical(root: string): Promise<string> {
  try { return await realpath(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const resolved = path.resolve(root), parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await canonical(parent), path.basename(resolved));
  }
}
async function writeRoots(directory: string, permission: AcpxRunRequest['permissionConfig'], local: boolean, extra: string[] = []) {
  const config = permission || DEFAULT_ACPX_PERMISSION_CONFIG;
  if (config.sandboxMode === 'read-only') return [];
  if (!local) return ['*']; // Remote workspace mapping is resolved later; conservatively serialize writes per host.
  // Admission reserves declared workspaces; full filesystem access does not reserve the entire host.
  return Promise.all([directory, ...(config.writableRoots ?? []), ...extra].map(root => canonical(root)));
}

/** Check new room runs against all active runs, and all other callers against new room runs. */
export async function assertRoomRunAvailable(tx: Prisma.TransactionClient, request: AcpxRunRequest, binding?: RoomRunBinding) {
  const runs = await tx.taskRun.findMany({ where: { status: { in: activeRunStatuses } }, include: { participants: true } });
  for (const run of runs) {
    const metadata = parseAcpxMetadata(run.controlMetadata);
    const prior = metadata.roomAdmission as RoomRunBinding | undefined;
    if (binding && prior?.memberId === binding.memberId) throw new Error('Room member already has an active run');
    if (!binding && !prior) continue;
    for (const participant of request.participants) for (const other of run.participants) {
      if (host(participant) !== host(other)) continue;
      const native = participant.resumeSessionId || participant.resumeThreadId;
      const oldMetadata = parseAcpxMetadata(other.controlMetadata);
      if (native && participant.harnessType === other.harnessType &&
        [oldMetadata.resumeSessionId, getContinuationSession(other).sessionId].includes(native)) throw new Error('Native session already has an active run');
      const local = host(participant) === 'local';
      const a = await writeRoots(request.workingDirectory || process.cwd(), request.permissionConfig, local);
      const resources = metadata.resources as { writableRoots?: string[] } | undefined;
      const participantResources = oldMetadata.resources as { writableRoots?: string[] } | undefined;
      const protectedRoots = [...(resources?.writableRoots || []), ...(participantResources?.writableRoots || [])];
      // Trusted local room members may collaborate in one base workspace. Explicit resource reservations remain exclusive.
      const b = local && binding && prior
        ? await Promise.all(protectedRoots.map(canonical))
        : await writeRoots(typeof metadata.workingDirectory === 'string' ? metadata.workingDirectory : '/',
          metadata.permissionConfig as AcpxRunRequest['permissionConfig'], local, protectedRoots);
      if (a.some(left => b.some(right => left === '*' || right === '*' || overlap(left, right)))) throw new Error(`Workspace write conflict with active run ${run.id}`);
    }
  }
  // Retain graph claim / unreleased Writer protection for ordinary local room writers.
  if (binding && request.participants[0].executionBackend === 'platform_local') {
    for (const directory of await writeRoots(request.workingDirectory || process.cwd(), request.permissionConfig, true)) {
      await assertWorkspaceWriterAvailable(tx, { directory });
    }
  }
  if (!request.graphExecution && !request.graphReview) {
    const siblings = runs.filter(run => run.taskSessionId === request.taskSessionId);
    if (siblings.some(run => !binding || !parseAcpxMetadata(run.controlMetadata).roomAdmission)) throw new Error('Session already has an active run');
  }
}
