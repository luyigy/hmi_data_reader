import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';

/**
 * Derive backend from agent properties
 */
const deriveBackend = (agent: { hostname: string | null; gatewayId: string | null; location: string | null }): string => {
  if (agent.hostname) return 'platform_local';
  if (agent.location === '本地') return 'platform_local';
  if (agent.location === '远程' || agent.location === '云端') return 'gateway_openclaw';
  if (agent.gatewayId) return 'gateway_openclaw';
  return 'unknown';
};

/**
 * PATCH /api/agents/[id]
 * 更新 Agent 的身份信息（昵称、颜色、图标等）
 *
 * Platform Local agents 现在支持全局昵称，因为它们已存储在数据库中
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
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
      const backend = deriveBackend(agent);
      shortAlias = generateShortAlias(
        userNickname,
        agent.type,
        agent.gateway?.name || null,
        backend,
        agent.hostname || null
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
        hostname: updated.hostname,
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
