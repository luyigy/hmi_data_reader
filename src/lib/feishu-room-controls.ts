import path from 'node:path';
import { getLocalHarnessPermissionSupport } from '@/lib/acpx/permissions';
import type { AcpxExecutionBackend } from '@/lib/acpx/types';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import {
  getBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import { interruptLiveRoomMemberReplies } from '@/lib/live-room-interrupt';
import {
  cancelQueuedLiveRoomMemberExecutions,
  waitForLiveRoomMemberExecutionStop,
} from '@/lib/live-room-process-registry';
import { permissionConfigForProfile } from '@/lib/live-room-permissions';
import { prisma } from '@/lib/prisma';

type RestrictableMember = {
  id: string;
  memberType: string;
  canReply: boolean;
};

export const selectRoomRestrictionTargets = <T extends RestrictableMember>(
  members: T[],
  target: string,
) => {
  const agents = members.filter((member) => member.memberType !== 'user' && member.canReply);
  return target === 'all' ? agents : agents.filter((member) => member.id === target);
};

export const supportsRoomWorkspaceConstraint = (
  member: { harnessType?: string | null; backend?: string | null },
  profile: 'safe_local' | 'dev_local',
) => {
  const support = getLocalHarnessPermissionSupport(
    member.harnessType || 'codex',
    (member.backend || 'platform_local') as AcpxExecutionBackend,
  );
  return support.sandboxMode === 'applied'
    && support.writableRoots === 'applied'
    && (profile !== 'safe_local' || support.networkAccess === 'applied');
};

export async function handleRoomRestrictionCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  const room = await getBoundLiveRoom(context);
  if (!room?.sourceTask) return '当前 Feishu 会话尚未绑定可管理的 Live Room。';

  const target = (command.options.agent || command.args[0] || '').trim();
  const requestedProfile = (command.options.profile || command.args[1] || '').trim();
  const profile = requestedProfile === 'safe' ? 'safe_local'
    : requestedProfile === 'dev' ? 'dev_local'
      : requestedProfile;
  if (!target || !['safe_local', 'dev_local'].includes(profile)) {
    return '用法：/ap restrict <agent-id|all> <safe|dev>';
  }

  const workspace = room.workingDirectory || room.sourceTask.workingDirectory || '';
  if (!path.isAbsolute(workspace)) {
    return '❌ 当前房间没有有效的绝对工作区路径，未修改权限。';
  }

  const members = selectRoomRestrictionTargets(room.members, target);
  if (!members.length) return `找不到可约束的 Agent：${target}`;

  const restrictedProfile = profile as 'safe_local' | 'dev_local';
  const unsupported = members.filter((member) =>
    !supportsRoomWorkspaceConstraint(member, restrictedProfile));
  if (unsupported.length) {
    return [
      '❌ 未应用权限：以下 Agent 的运行时不能真实执行所选工作区约束。',
      ...unsupported.map((member) => `- ${member.userNickname || member.displayName}`),
      '本次为全有或全无处理；没有停止任何运行，也没有修改权限。',
    ].join('\n');
  }

  const permission = permissionConfigForProfile(restrictedProfile, [workspace]);
  const serializedPermission = JSON.stringify(permission);
  await prisma.$transaction(async (transaction) => {
    await transaction.liveRoomMember.updateMany({
      where: { id: { in: members.map((member) => member.id) } },
      data: { acpxPermissionConfig: serializedPermission },
    });
    if (target === 'all') {
      await transaction.task.update({
        where: { id: room.sourceTask!.id },
        data: { acpxPermissionConfig: serializedPermission },
      });
    }
  });

  members.forEach((member) => cancelQueuedLiveRoomMemberExecutions(member.id));
  const interruptions = await Promise.all(members.map((member) =>
    interruptLiveRoomMemberReplies({
      roomId: room.id,
      memberId: member.id,
      controlAction: 'stop_run',
    })));
  if (interruptions.some((result) => result.failedRunningCount > 0)) {
    return '⚠️ 新运行已约束到房间工作区，但旧运行未能全部停止；请立即使用 /ap stop 后重试。';
  }
  try {
    await Promise.all(members.map((member) => waitForLiveRoomMemberExecutionStop(member.id)));
  } catch {
    return '⚠️ 新运行已约束到房间工作区，但等待旧运行停止超时；请立即使用 /ap stop 后确认。';
  }

  return [
    `✅ 已将 ${target === 'all' ? `当前房间全部 ${members.length} 个 Agent` : '所选 Agent'} 约束到房间工作区`,
    `工作区：${workspace}`,
    `权限档位：${profile === 'safe_local' ? 'Safe Local（禁止网络）' : 'Dev Local（允许网络）'}`,
    '生效状态：旧运行和排队任务已停止；后续运行只允许写入该工作区。',
  ].join('\n');
}
