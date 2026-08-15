import { prisma } from '@/lib/prisma';
import { getRealAgentsStatus } from '@/lib/real-agents';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';
import type { AuthUser } from '@/lib/auth-users';
import type { AcpxExecutionBackend } from './types';

export interface HarnessOption {
  gatewayId: string;
  gatewayName: string;
  executionBackend: AcpxExecutionBackend;
  harnessType: string;
  harnessLabel: string;
  agentId?: string;
  agentName?: string;
  userNickname?: string | null;  // User-defined nickname from Agent table
  hostname?: string | null;       // Server hostname for platform_local agents
  runtimeAgentId?: string;
  status: string;
}

const normalizeHarnessType = (value?: string | null) => {
  const normalized = (value || '').trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized.includes('antigravity') || normalized === 'agy') {
    return 'antigravity';
  }
  if (normalized.includes('codex')) {
    return 'codex';
  }
  if (normalized === 'claude-haha') {
    return 'claude-haha';
  }
  if (normalized === 'claude') {
    return 'claude';
  }
  if (normalized.includes('gemini')) {
    return 'gemini-cli';
  }
  if (normalized.includes('pi-agent') || normalized === 'pi') {
    return 'pi-agent';
  }
  if (normalized.includes('kimi-code') || normalized === 'kimi') {
    return 'kimi-code';
  }
  if (normalized.includes('deepseek')) {
    return 'deepseek';
  }

  return normalized;
};

const toTitleCase = (value: string) =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const parseSupportedHarnesses = (value?: string | null): string[] => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => normalizeHarnessType(item))
          .filter((item): item is string => Boolean(item))
      : [];
  } catch {
    return [];
  }
};

export const deriveGatewayHarnessOptions = async (
  user?: Pick<AuthUser, 'id' | 'role'>,
): Promise<HarnessOption[]> => {
  if (user && user.role !== 'admin') {
    // Non-admin users may only execute through remote nodes they own (see
    // requireExecutionAccess). Surface exactly those, never platform-local
    // hosts, global gateways, or shared SSH hosts.
    const owned = await prisma.remoteNode.findMany({
      where: { ownerUserId: user.id },
      orderBy: { name: 'asc' },
    });
    return buildRemoteNodeOptions(owned);
  }
  const currentHostname = getServerHostname();
  await ensurePlatformLocalAgents();
  const [gateways, localStatus, remoteHosts, platformLocalAgents, remoteNodes] = await Promise.all([
    prisma.gateway.findMany({
      include: {
        agents: {
          orderBy: {
            name: 'asc',
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    }),
    getRealAgentsStatus(),
    prisma.remoteHarnessHost.findMany({
      orderBy: {
        label: 'asc',
      },
    }),
    // Get platform local agents from database with their nicknames and hostnames
    prisma.agent.findMany({
      where: {
        hostname: { not: null },
      },
      orderBy: {
        name: 'asc',
      },
    }),
    prisma.remoteNode.findMany({ orderBy: { name: 'asc' } }),
  ]);

  const options: HarnessOption[] = [];
  let currentHostPlatformLocalCount = 0;
  const availabilityByHarness = localStatus as Record<string, { available: boolean; version?: string }>;

  // Platform local agents from database (with hostname)
  for (const agent of platformLocalAgents) {
    if ((agent.hostname || '').trim() !== currentHostname) {
      continue;
    }
    currentHostPlatformLocalCount += 1;

    const harnessType = normalizeHarnessType(agent.name) || agent.type;

    if (!harnessType) {
      continue;
    }

    // Check if this harness type is available locally
    const isAvailable = availabilityByHarness[harnessType]?.available ?? true;

    if (!isAvailable) {
      continue;
    }

    const hostname = agent.hostname || 'localhost';
    const hostnameShort = hostname.split('.')[0];

    options.push({
      gatewayId: 'platform-local',
      gatewayName: `Platform Local (${hostnameShort})`,
      executionBackend: 'platform_local',
      harnessType,
      harnessLabel: `Platform Local (${hostnameShort}) / ${toTitleCase(harnessType)} CLI`,
      agentId: agent.id,
      agentName: agent.name,
      userNickname: agent.userNickname,
      hostname: agent.hostname,
      runtimeAgentId: harnessType,
      status: agent.status,
    });
  }

  // Fallback: If no platform local agents in DB, add defaults (for backwards compatibility)
  if (currentHostPlatformLocalCount === 0) {
    if (localStatus.antigravity.available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'antigravity',
        harnessLabel: 'Platform Local / Antigravity CLI',
        agentId: 'platform-local:antigravity',
        agentName: 'Platform Local Antigravity',
        runtimeAgentId: 'antigravity',
        status: 'online',
      });
    }

    if (localStatus.codex.available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'codex',
        harnessLabel: 'Platform Local / Codex CLI',
        agentId: 'platform-local:codex',
        agentName: 'Platform Local Codex',
        runtimeAgentId: 'codex',
        status: 'online',
      });
    }

    if (localStatus.claude.available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'claude',
        harnessLabel: 'Platform Local / Claude Code CLI',
        agentId: 'platform-local:claude',
        agentName: 'Platform Local Claude',
        runtimeAgentId: 'claude',
        status: 'online',
      });
    }

    if (localStatus.deepseek.available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'deepseek',
        harnessLabel: 'Platform Local / DeepSeek TUI',
        agentId: 'platform-local:deepseek',
        agentName: 'Platform Local DeepSeek',
        runtimeAgentId: 'deepseek',
        status: 'online',
      });
    }

    if (localStatus['gemini-cli'].available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'gemini-cli',
        harnessLabel: 'Platform Local / Gemini CLI',
        agentId: 'platform-local:gemini',
        agentName: 'Platform Local Gemini',
        runtimeAgentId: 'gemini-cli',
        status: 'online',
      });
    }

    if (localStatus['pi-agent'].available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'pi-agent',
        harnessLabel: 'Platform Local / Pi Agent',
        agentId: 'platform-local:pi-agent',
        agentName: 'Platform Local Pi Agent',
        runtimeAgentId: 'pi-agent',
        status: 'online',
      });
    }

    if (localStatus['kimi-code'].available) {
      options.push({
        gatewayId: 'platform-local',
        gatewayName: 'Platform Local',
        executionBackend: 'platform_local',
        harnessType: 'kimi-code',
        harnessLabel: 'Platform Local / Kimi Code CLI',
        agentId: 'platform-local:kimi-code',
        agentName: 'Platform Local Kimi Code',
        runtimeAgentId: 'kimi-code',
        status: 'online',
      });
    }
  }

  for (const gateway of gateways) {
    if (gateway.status !== 'online') {
      continue;
    }

    for (const agent of gateway.agents) {
      const harnessType =
        normalizeHarnessType(agent.runtimeAgentId) ||
        normalizeHarnessType(agent.name) ||
        normalizeHarnessType(agent.type);

      if (!harnessType || (agent.status !== 'online' && agent.status !== 'busy')) {
        continue;
      }

      const harnessLabel = `${gateway.name} / ${toTitleCase(harnessType)}`;

      options.push({
        gatewayId: gateway.id,
        gatewayName: gateway.name,
        executionBackend: 'gateway_openclaw',
        harnessType,
        harnessLabel,
        agentId: agent.id,
        agentName: agent.name,
        userNickname: agent.userNickname,
        hostname: agent.hostname,
        runtimeAgentId: agent.runtimeAgentId || undefined,
        status: agent.status,
      });
    }
  }

  for (const host of remoteHosts) {
    const supportedHarnesses = parseSupportedHarnesses(host.supportedHarnesses);

    for (const harnessType of supportedHarnesses) {
      options.push({
        gatewayId: host.id,
        gatewayName: host.label,
        executionBackend: 'remote_ssh',
        harnessType,
        harnessLabel: `${host.label} / ${toTitleCase(harnessType)} SSH`,
        agentId: `remote-ssh:${host.id}:${harnessType}`,
        agentName: `${host.label} ${toTitleCase(harnessType)}`,
        runtimeAgentId: harnessType,
        status: host.status,
      });
    }
  }

  return [...options, ...buildRemoteNodeOptions(remoteNodes)];
};

const buildRemoteNodeOptions = (nodes: Awaited<ReturnType<typeof prisma.remoteNode.findMany>>): HarnessOption[] => {
  const nodeOptions: HarnessOption[] = [];
  for (const node of nodes) {
    let metadata: { harnesses?: unknown; workspace?: unknown } = {};
    try {
      metadata = node.metadata ? JSON.parse(node.metadata) : {};
    } catch {
      // Ignore stale metadata; the next hello refreshes it.
    }
    const harnesses = Array.isArray(metadata.harnesses)
      ? metadata.harnesses.filter((value): value is string => typeof value === 'string')
      : [];
    for (const harnessType of harnesses) {
      nodeOptions.push({
        gatewayId: `remote-node:${node.name}`,
        gatewayName: node.name,
        executionBackend: 'remote_ssh',
        harnessType,
        harnessLabel: `${node.name} / ${toTitleCase(harnessType)} Runner`,
        agentId: `remote-node:${node.name}:${harnessType}`,
        agentName: `${node.name} ${toTitleCase(harnessType)}`,
        hostname: node.name,
        runtimeAgentId: harnessType,
        status: node.status,
      });
    }
  }
  return nodeOptions;
};
