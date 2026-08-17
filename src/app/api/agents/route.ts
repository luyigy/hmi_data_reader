import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  generateDisplayName,
  generateShortAlias,
  generateDefaultColorTag,
  generateDefaultEmojiIcon,
} from '@/lib/agent-identity';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';
import { computeEffectiveAgentStatus } from '@/lib/agent-effective-status';

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

/** Parse the stored capabilities JSON into a string array; unparseable/absent data reads as an empty array (never fabricated defaults). */
const parseCapabilities = (raw: string | null): string[] => {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((cap) => typeof cap === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * GET /api/agents
 * 获取所有 Agent 列表，包含身份信息
 *
 * 响应契约（Dashboard AgentCard 等消费方依赖）：
 * - `name`: 卡片标题使用的显示名（与 `displayName` 同值，保留 `displayName`
 *   供 /agents、/tasks 与创建表单等既有消费者使用）；
 * - `lastHeartbeat`: ISO 时间字符串；
 * - `status`: 有效状态。远程 Gateway Agent 按已存状态 + 心跳新鲜度
 *   （90 秒阈值）共同计算；Platform Local 保留已存状态语义；
 * - `storedStatus`: 数据库中的原始状态；
 * - `capabilities`: 字符串数组（上游未上报时为空数组，不伪造默认值）。
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
        name: displayName,
        userNickname: agent.userNickname || null,
        shortAlias,
        roleDescription: agent.roleDescription || null,
        colorTag,
        emojiIcon,
        hostname,
        status: computeEffectiveAgentStatus({ backend, status: agent.status, lastHeartbeat: agent.lastHeartbeat }),
        storedStatus: agent.status,
        type: agent.type,
        runtimeAgentId: agent.runtimeAgentId,
        gateway: agent.gateway ? {
          id: agent.gateway.id,
          name: agent.gateway.name,
        } : null,
        location: agent.location,
        backend,
        isPlatformLocal,
        capabilities: parseCapabilities(agent.capabilities),
        lastHeartbeat: agent.lastHeartbeat.toISOString(),
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
