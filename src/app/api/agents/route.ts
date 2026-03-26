import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  buildAgentIdentity,
  generateDisplayName,
  generateShortAlias,
  generateDefaultColorTag,
  generateDefaultEmojiIcon,
} from '@/lib/agent-identity';

/**
 * 生成原始名称（用于识别是哪个 agent）
 * 例如: "Platform Local - Claude", "Linux Gateway - Claude", "TX-server - Claude"
 */
const generateRawName = (
  harnessType: string,
  gatewayName: string | null,
  backend: string | null
): string => {
  const titleCase = harnessType
    .toLowerCase()
    .split(/[_\s-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  if (backend === 'platform_local') {
    return `Platform Local - ${titleCase}`;
  }

  if (gatewayName) {
    return `${gatewayName} - ${titleCase}`;
  }

  return titleCase;
};

/**
 * GET /api/agents
 * 获取所有 Agent 列表，包含身份信息
 */
export async function GET() {
  try {
    const agents = await prisma.agent.findMany({
      include: {
        gateway: true,
      },
      orderBy: [
        { gateway: { name: 'asc' } },
        { type: 'asc' },
      ],
    });

    // 统计每种类型的 agent 数量，用于生成显示名称
    const typeCounts = new Map<string, number>();
    agents.forEach((agent) => {
      const count = typeCounts.get(agent.type) || 0;
      typeCounts.set(agent.type, count + 1);
    });

    const result = agents.map((agent) => {
      // 使用数据库中的原始 name 作为主要标识
      // 这个 name 来自 gateway，是唯一的（如 "main", "claude-3.5", "codex" 等）
      const originalName = agent.name;

      // 生成完整的原始名称（包含 gateway 信息）
      const rawName = generateRawName(agent.type, agent.gateway?.name || null, agent.location || null);

      // 如果有昵称就用昵称，否则用原始名称
      const displayName = agent.userNickname || originalName;

      // 生成简短别名
      const shortAlias = agent.userNickname
        ? generateShortAlias(
            displayName,
            agent.type,
            agent.gateway?.name || null,
            agent.location
          )
        : null;

      // 颜色标签和表情图标
      const colorTag = agent.colorTag ||
        generateDefaultColorTag(agent.type, agent.gatewayId);
      const emojiIcon = agent.emojiIcon ||
        generateDefaultEmojiIcon(agent.type);

      return {
        id: agent.id,
        agentKey: `${agent.gatewayId || 'platform_local'}:${agent.type}`,
        originalName,  // 来自 gateway 的原始名称
        rawName,       // 包含 gateway 的完整名称
        displayName,
        userNickname: agent.userNickname || null,
        shortAlias,
        roleDescription: agent.roleDescription || null,
        colorTag,
        emojiIcon,
        status: agent.status,
        type: agent.type,
        runtimeAgentId: agent.runtimeAgentId,
        gateway: agent.gateway ? {
          id: agent.gateway.id,
          name: agent.gateway.name,
        } : null,
        location: agent.location,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
      };
    });

    return NextResponse.json({ agents: result });
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agents' },
      { status: 500 }
    );
  }
}
