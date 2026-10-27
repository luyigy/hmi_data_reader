import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';
import { graphMemberPermissionTask } from './room-permission-task';
import { normalizeAcpxPermissionConfig } from '../acpx/permissions';

const parse = (value: string | null) => { try { return value ? JSON.parse(value) : null; } catch { return undefined; } };
export type PermissionMigrationRow = { memberId: string; roomId: string; decision: 'inherit' | 'preserve' | 'ambiguous' | 'already_inherited'; reason: string; before: string | null; after: string | null; taskId?: string; taskPermission?: string | null };

/** Audit-only by default. Historical missing audit is ambiguity, never evidence of no user edit. */
export async function migrateGraphRoomPermissions(roomId: string, apply = false): Promise<PermissionMigrationRow[]> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "LiveRoom" WHERE id = ${roomId} FOR UPDATE`;
    const room = await tx.liveRoom.findUniqueOrThrow({ where: { id: roomId }, include: { members: true } });
    const job = room.sourceTaskId ? await tx.taskGraphExecution.findUnique({ where: { childTaskId: room.sourceTaskId } }) : null;
    if (!job) throw new Error('Permission migration requires a registered graph room');
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } });
    const rows: PermissionMigrationRow[] = [];
    for (const candidate of room.members.filter(member => member.memberType === 'local_agent')) {
      await tx.$queryRaw`SELECT id FROM "LiveRoomMember" WHERE id = ${candidate.id} FOR UPDATE`;
      const member = await tx.liveRoomMember.findUniqueOrThrow({ where: { id: candidate.id } });
      const row: PermissionMigrationRow = { memberId: member.id, roomId, before: member.acpxPermissionConfig, after: member.acpxPermissionConfig, decision: 'preserve', reason: 'Explicit or non-default permission' };
      rows.push(row);
      if (member.acpxPermissionConfig === null) { row.decision = 'already_inherited'; row.reason = 'Already inherits task authorization'; continue; }
      if (!isDeepStrictEqual(parse(member.acpxPermissionConfig), taskGraphAgentReviewPermissionConfig)) continue;
      row.decision = 'ambiguous';
      const events = await tx.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: { in: ['room_member_permission_origin', 'room_member_permission_changed'] }, payload: { path: ['memberId'], equals: member.id } }, orderBy: { createdAt: 'asc' } });
      const origin = events.find(event => event.kind === 'room_member_permission_origin')?.payload as Record<string, unknown> | undefined;
      if (!origin || origin.source !== 'graph_participant_default_v1' || origin.roomId !== roomId || origin.taskId !== room.sourceTaskId ||
        origin.createdAt !== member.createdAt.toISOString() || origin.updatedAt !== member.updatedAt.toISOString() ||
        !isDeepStrictEqual(parse(typeof origin.permission === 'string' ? origin.permission : null), taskGraphAgentReviewPermissionConfig)) {
        row.reason = 'Missing complete platform-origin and unchanged-row evidence'; continue;
      }
      if (events.some(event => event.kind === 'room_member_permission_changed')) { row.decision = 'preserve'; row.reason = 'User permission change recorded'; continue; }
      const task = await graphMemberPermissionTask(tx, member, room.sourceTaskId);
      if (!task) { row.reason = 'No unambiguous registered role task authorization'; continue; }
      const taskId = task.id;
      const permission = parse(task.acpxPermissionConfig);
      if (!permission || !isDeepStrictEqual(normalizeAcpxPermissionConfig(permission), permission)) { row.reason = 'Task permission is absent or not a complete explicit configuration'; continue; }
      row.taskId = taskId; row.taskPermission = task.acpxPermissionConfig;
      row.decision = 'inherit'; row.after = null; row.reason = 'Exact platform default with unchanged creation receipt; inherit verified role task permission';
      if (apply) {
        await tx.liveRoomMember.update({ where: { id: member.id }, data: { acpxPermissionConfig: null } });
        await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id, kind: 'room_member_permission_migrated',
          idempotencyKey: `room-permission-migration:${member.id}:${randomUUID()}`, payload: row } });
      }
    }
    return rows;
  });
}
