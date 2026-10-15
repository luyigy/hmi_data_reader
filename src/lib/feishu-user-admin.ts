import { prisma } from '@/lib/prisma';
import { resolveWorkspaceRoot } from '@/lib/feishu-workspace';
import { permissionConfigForProfile, resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import { supportsRoomWorkspaceConstraint } from '@/lib/feishu-room-controls';
import { interruptLiveRoomMemberReplies } from '@/lib/live-room-interrupt';
import { cancelQueuedLiveRoomMemberExecutions, waitForLiveRoomMemberExecutionStop } from '@/lib/live-room-process-registry';

export type ManagedUserProfile = 'safe_local' | 'dev_local';

export const isFeishuUserAdmin = (openId: string | null | undefined) =>
  !!openId && openId === process.env.FEISHU_ADMIN_OPEN_ID?.trim();

export async function readFeishuUserAdminDetail(openId: string) {
  const user = await prisma.feishuUserAccess.findUnique({ where: { openId } });
  if (!user) throw new Error('找不到该飞书用户。');
  const binding = user.chatId ? await prisma.feishuConversationBinding.findFirst({
    where: { chatId: user.chatId, chatType: 'p2p', senderOpenId: openId },
    select: { liveRoomId: true },
  }) : null;
  const room = binding ? await prisma.liveRoom.findUnique({
    where: { id: binding.liveRoomId },
    include: { sourceTask: true, members: true },
  }) : null;
  const agents = room?.members.filter((member) => member.memberType !== 'user' && member.canReply) ?? [];
  return {
    user,
    room,
    agents: agents.map((member) => ({
      member,
      permission: resolveLiveRoomMemberPermission(
        member.acpxPermissionConfig, room?.sourceTask?.acpxPermissionConfig,
      ),
    })),
  };
}

export async function updateFeishuUserAdmin(args: {
  actorOpenId: string | null | undefined;
  userOpenId: string;
  workspaceRoot: string;
  profile: ManagedUserProfile;
}) {
  if (!isFeishuUserAdmin(args.actorOpenId)) throw new Error('仅配置的飞书管理员可以修改用户。');
  if (!['safe_local', 'dev_local'].includes(args.profile)) throw new Error('只支持 Safe Local 或 Dev Local。');
  const workspaceRoot = await resolveWorkspaceRoot(args.workspaceRoot);
  const detail = await readFeishuUserAdminDetail(args.userOpenId);
  const room = detail.room;
  if (detail.user.status !== 'approved' || !room?.sourceTask) {
    throw new Error('用户尚未批准或私聊房间未就绪；请先完成准入审批。');
  }
  const unsupported = detail.agents.filter(({ member }) =>
    !supportsRoomWorkspaceConstraint(member, args.profile));
  if (unsupported.length) {
    throw new Error(`以下 Agent 不能真实应用所选目录和网络约束：${unsupported.map(({ member }) => member.displayName).join('、')}`);
  }

  const permission = JSON.stringify(permissionConfigForProfile(args.profile, [workspaceRoot]));
  await prisma.$transaction(async (transaction) => {
    await transaction.feishuUserAccess.update({
      where: { openId: args.userOpenId },
      data: { workspaceRoot, decidedBy: args.actorOpenId, decidedAt: new Date() },
    });
    await transaction.liveRoom.update({
      where: { id: room.id }, data: { workingDirectory: workspaceRoot },
    });
    await transaction.task.update({
      where: { id: room.sourceTask!.id },
      data: { workingDirectory: workspaceRoot, acpxPermissionConfig: permission },
    });
    if (detail.agents.length) await transaction.liveRoomMember.updateMany({
      where: { id: { in: detail.agents.map(({ member }) => member.id) } },
      data: { acpxPermissionConfig: permission },
    });
  });

  const members = detail.agents.map(({ member }) => member);
  members.forEach((member) => cancelQueuedLiveRoomMemberExecutions(member.id));
  const stops = await Promise.allSettled(members.map((member) => interruptLiveRoomMemberReplies({
    roomId: room.id, memberId: member.id, controlAction: 'stop_run',
  })));
  if (stops.some((result) => result.status === 'rejected' || result.value.failedRunningCount > 0)) {
    return '配置已保存，但有旧运行未停止；请在该用户房间执行 /ap stop。';
  }
  try {
    await Promise.all(members.map((member) => waitForLiveRoomMemberExecutionStop(member.id)));
  } catch {
    return '配置已保存，但等待旧运行停止超时；请在该用户房间确认 /ap stop。';
  }
  return `已更新：${workspaceRoot} · ${args.profile === 'safe_local' ? 'Safe Local（离线）' : 'Dev Local（联网）'}。后续运行使用新权限。`;
}
