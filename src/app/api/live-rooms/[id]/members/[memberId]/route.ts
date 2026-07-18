import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';
import { postLiveRoomMessage, resolveLiveRoomMessageMetadata, syncLiveRoomSourceTask } from '@/lib/live-room';
import {
  setLiveRoomMemberPermission,
  type LiveRoomPermissionProfile,
} from '@/lib/live-room-permissions';
import { normalizeCodexMemberSettings } from '@/lib/live-room-codex-settings';

/**
 * DELETE /api/live-rooms/[id]/members/[memberId]
 * 从 Live Room 移除成员
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; memberId: string } }
) {
  try {
    const member = await prisma.liveRoomMember.findUnique({
      where: { id: params.memberId },
    });

    if (!member || member.roomId !== params.id) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    if (member.memberType === 'user') {
      return NextResponse.json({ error: 'Cannot remove the user member' }, { status: 400 });
    }

    await prisma.liveRoomMember.delete({ where: { id: params.memberId } });

    // If this was the current speaker, clear it
    const room = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      select: { currentSpeakerMemberId: true },
    });
    if (room?.currentSpeakerMemberId === params.memberId) {
      const next = await prisma.liveRoomMember.findFirst({
        where: { roomId: params.id, canReply: true },
        orderBy: { sortOrder: 'asc' },
      });
      await prisma.liveRoom.update({
        where: { id: params.id },
        data: { currentSpeakerMemberId: next?.id ?? null },
      });
    }

    await postLiveRoomMessage({
      roomId: params.id,
      content: `${member.displayName} 已从房间移除。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: { systemEvent: 'member_removed', memberId: params.memberId },
      }),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to remove live room member:', error);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}

/**
 * PATCH /api/live-rooms/[id]/members/[memberId]
 * 更新 Live Room 成员的房间专属昵称
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string; memberId: string } }
) {
  try {
    const body = await request.json();
    const { userNickname, shortAlias } = body;
    const role = typeof body.role === 'string' ? body.role.trim() || 'custom' : undefined;
    const permissionProfile = (['safe_local', 'dev_local', 'full_access'].includes(body.permissionProfile)
      ? body.permissionProfile
      : undefined) as LiveRoomPermissionProfile | undefined;
    const hasCodexSettings = 'codexModel' in body || 'codexReasoningEffort' in body;

    // 验证成员存在
    const member = await prisma.liveRoomMember.findUnique({
      where: { id: params.memberId },
      include: {
        agentRecord: {
          include: { gateway: true },
        },
        gateway: true,
      },
    });

    if (!member) {
      return NextResponse.json(
        { error: 'Member not found' },
        { status: 404 }
      );
    }
    if (member.roomId !== params.id) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    const codexSettings = hasCodexSettings
      ? normalizeCodexMemberSettings({
          model: 'codexModel' in body ? body.codexModel : member.codexModel,
          reasoningEffort: 'codexReasoningEffort' in body
            ? body.codexReasoningEffort
            : member.codexReasoningEffort,
        })
      : null;
    if (codexSettings && member.harnessType !== 'codex') {
      return NextResponse.json({ error: 'Model settings are only supported for Codex members' }, { status: 400 });
    }

    // 如果设置了昵称但未提供 shortAlias，自动生成
    let generatedShortAlias = shortAlias;
    if (userNickname && !shortAlias) {
      generatedShortAlias = generateShortAlias(
        userNickname,
        member.harnessType || 'unknown',
        member.gateway?.name || null,
        member.backend
      );
    }

    // 更新成员
    const updated = await prisma.liveRoomMember.update({
      where: { id: params.memberId },
      data: {
        userNickname: userNickname ?? undefined,
        shortAlias: generatedShortAlias ?? undefined,
        role,
        codexModel: codexSettings?.model,
        codexReasoningEffort: codexSettings?.reasoningEffort,
      },
    });
    if (permissionProfile) {
      await setLiveRoomMemberPermission(params.id, params.memberId, permissionProfile);
    }
    await syncLiveRoomSourceTask(params.id);

    return NextResponse.json({
      success: true,
      member: {
        id: updated.id,
        displayName: updated.displayName,
        userNickname: updated.userNickname,
        shortAlias: updated.shortAlias,
        role: updated.role,
        permissionProfile,
        codexModel: updated.codexModel,
        codexReasoningEffort: updated.codexReasoningEffort,
      },
    });
  } catch (error) {
    console.error('Failed to update member:', error);
    const message = error instanceof Error ? error.message : 'Failed to update member';
    return NextResponse.json({ error: message }, { status: message.startsWith('Invalid Codex') ? 400 : 500 });
  }
}
