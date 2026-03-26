import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';

// Platform Local agents are built-in and don't have database records
const PLATFORM_LOCAL_AGENTS = new Set(['platform-local:claude', 'platform-local:codex']);

/**
 * PATCH /api/agents/[id]
 * 更新 Agent 的身份信息（昵称、颜色、图标等）
 *
 * 注意: Platform Local agents (platform-local:claude, platform-local:codex) 不支持
 * 全局昵称修改，请使用 Live Room 的房间专属昵称功能
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    // Platform Local agents 不支持直接修改（无数据库记录）
    if (PLATFORM_LOCAL_AGENTS.has(params.id)) {
      return NextResponse.json(
        {
          error: 'Platform Local agents do not support global nicknames.',
          message: 'Please use room-specific nicknames in Live Rooms instead.',
          suggestion: 'Use PATCH /api/live-rooms/{roomId}/members/{memberId} to set room-specific nicknames.',
        },
        { status: 400 }
      );
    }

    const body = await request.json();
    const {
      userNickname,
      roleDescription,
      colorTag,
      emojiIcon,
    } = body;

    // 验证 Agent 存在
    const agent = await prisma.agent.findUnique({
      where: { id: params.id },
      include: { gateway: true },
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    // 如果设置了昵称，自动生成简短别名
    let shortAlias = null;
    if (userNickname) {
      shortAlias = generateShortAlias(
        userNickname,
        agent.type,
        agent.gateway?.name || null,
        agent.location
      );
    }

    // 更新 Agent
    const updated = await prisma.agent.update({
      where: { id: params.id },
      data: {
        userNickname: userNickname ?? undefined,
        roleDescription: roleDescription ?? undefined,
        colorTag: colorTag ?? undefined,
        emojiIcon: emojiIcon ?? undefined,
      },
      include: {
        gateway: true,
      },
    });

    return NextResponse.json({
      success: true,
      agent: {
        id: updated.id,
        agentKey: `${updated.gatewayId || 'platform_local'}:${updated.type}`,
        displayName: userNickname || updated.name,
        userNickname: updated.userNickname,
        shortAlias,
        roleDescription: updated.roleDescription,
        colorTag: updated.colorTag,
        emojiIcon: updated.emojiIcon,
      },
    });
  } catch (error) {
    console.error('Failed to update agent:', error);
    return NextResponse.json(
      { error: 'Failed to update agent' },
      { status: 500 }
    );
  }
}
