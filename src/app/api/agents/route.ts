import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
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
 *
 * 包括:
 * 1. 数据库中的 Agent (来自 gateway)
 * 2. Platform Local agents (内置的本地 Claude/Codex)
 */
export async function GET() {
  try {
    // 1. 获取数据库中的 Agent
    const dbAgents = await prisma.agent.findMany({
      include: {
        gateway: true,
      },
      orderBy: [
        { gateway: { name: 'asc' } },
        { type: 'asc' },
      ],
    });

    // 2. 构建 platform_local agents (内置本地 agents)
    const platformLocalAgents = [
      {
        id: 'platform-local:claude',
        agentKey: 'platform-local:claude',
        originalName: 'Platform Local Claude',
        rawName: 'Platform Local - Claude',
        displayName: 'Platform Local Claude',
        userNickname: null,
        shortAlias: null,
        roleDescription: null,
        colorTag: '#4A90E2',
        emojiIcon: '🤖',
        status: 'online',
        type: 'claude',
        runtimeAgentId: 'claude',
        gateway: null,
        location: '本地',
        backend: 'platform_local',
        isPlatformLocal: true,
        capabilities: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'platform-local:codex',
        agentKey: 'platform-local:codex',
        originalName: 'Platform Local Codex',
        rawName: 'Platform Local - Codex',
        displayName: 'Platform Local Codex',
        userNickname: null,
        shortAlias: null,
        roleDescription: null,
        colorTag: '#F5A623',
        emojiIcon: '💻',
        status: 'online',
        type: 'codex',
        runtimeAgentId: 'codex',
        gateway: null,
        location: '本地',
        backend: 'platform_local',
        isPlatformLocal: true,
        capabilities: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    // 3. 处理数据库 agents
    const result = dbAgents.map((agent) => {
      const originalName = agent.name;
      const rawName = generateRawName(agent.type, agent.gateway?.name || null, agent.location || null);
      const displayName = agent.userNickname || originalName;
      const shortAlias = agent.userNickname
        ? generateShortAlias(displayName, agent.type, agent.gateway?.name || null, agent.location)
        : null;
      const colorTag = agent.colorTag || generateDefaultColorTag(agent.type, agent.gatewayId);
      const emojiIcon = agent.emojiIcon || generateDefaultEmojiIcon(agent.type);

      return {
        id: agent.id,
        agentKey: `${agent.gatewayId || 'platform_local'}:${agent.type}`,
        originalName,
        rawName,
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
        backend: agent.location === '本地' ? 'platform_local' : agent.location === '远程' ? 'gateway_openclaw' : agent.location === '云端' ? 'gateway_openclaw' : 'unknown',
        isPlatformLocal: false,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
      };
    });

    // 4. 合并 platform_local agents
    const allAgents = [...platformLocalAgents, ...result];

    return NextResponse.json({ agents: allAgents });
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agents' },
      { status: 500 }
    );
  }
}
