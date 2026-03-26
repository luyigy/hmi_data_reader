import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  generateDisplayName,
  generateShortAlias,
  generateDefaultColorTag,
  generateDefaultEmojiIcon,
} from '@/lib/agent-identity';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';

/**
 * 生成原始名称（用于识别是哪个 agent）
 * 例如: "Platform Local - Claude", "Linux Gateway - Claude", "server-01 - Claude"
 */
const generateRawName = (
  harnessType: string,
  gatewayName: string | null,
  isPlatformLocal: boolean,
  hostname: string | null = null
): string => {
  const titleCase = harnessType
    .toLowerCase()
    .split(/[_\s-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  if (isPlatformLocal) {
    if (hostname) {
      const hostnameShort = hostname.split('.')[0];
      return `${hostnameShort} - ${titleCase}`;
    }
    return `Platform Local - ${titleCase}`;
  }

  if (gatewayName) {
    return `${gatewayName} - ${titleCase}`;
  }

  return titleCase;
};

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
 * GET /api/agents
 * 获取所有 Agent 列表，包含身份信息
 *
 * 包括:
 * 1. 数据库中的 Agent (来自 gateway)
 * 2. Platform Local agents (内置的本地 Claude/Codex)
 */
export async function GET() {
  try {
    // 1. Ensure platform local agents exist in database
    await ensurePlatformLocalAgents();
    const currentHostname = getServerHostname();

    // 2. 获取数据库中的所有 Agent (包括 platform_local)
    const dbAgents = await prisma.agent.findMany({
      include: {
        gateway: true,
      },
      orderBy: [
        // Platform local agents first, grouped by hostname
        { hostname: { sort: 'asc', nulls: 'first' } },
        { gateway: { name: 'asc' } },
        { type: 'asc' },
      ],
    });

    // 3. 统计每个 harnessType 的数量（用于生成 displayName）
    const typeCount = new Map<string, number>();
    for (const agent of dbAgents) {
      const backend = deriveBackend(agent);
      const key = `${backend}:${agent.type}`;
      typeCount.set(key, (typeCount.get(key) || 0) + 1);
    }

    // 4. 处理所有 agents
    const result = dbAgents.map((agent) => {
      const hostname = agent.hostname || null;
      const backend = deriveBackend(agent);
      const isPlatformLocal = backend === 'platform_local';

      const originalName = agent.name;

      // 生成显示名称
      const displayName = agent.userNickname || generateDisplayName(
        agent.type,
        agent.gateway?.name || null,
        backend,
        typeCount.get(`${backend}:${agent.type}`) || 1,
        hostname
      );

      const rawName = generateRawName(
        agent.type,
        agent.gateway?.name || null,
        isPlatformLocal,
        hostname
      );

      const shortAlias = agent.userNickname
        ? generateShortAlias(displayName, agent.type, agent.gateway?.name || null, backend, hostname)
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
        hostname,
        status: agent.status,
        type: agent.type,
        runtimeAgentId: agent.runtimeAgentId,
        gateway: agent.gateway ? {
          id: agent.gateway.id,
          name: agent.gateway.name,
        } : null,
        location: agent.location,
        backend,
        isPlatformLocal,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
      };
    });

    return NextResponse.json({ agents: result });
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agents', details: String(error) },
      { status: 500 }
    );
  }
}
