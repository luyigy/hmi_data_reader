import { prisma } from '@/lib/prisma';
import { getRealAgentsStatus } from '@/lib/real-agents';
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

  if (normalized.includes('codex')) {
    return 'codex';
  }
  if (normalized.includes('claude')) {
    return 'claude';
  }
  if (normalized.includes('gemini')) {
    return 'gemini-cli';
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

export const deriveGatewayHarnessOptions = async (): Promise<HarnessOption[]> => {
  const [gateways, localStatus, remoteHosts, platformLocalAgents] = await Promise.all([
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
  ]);

  const options: HarnessOption[] = [];

  // Platform local agents from database (with hostname)
  for (const agent of platformLocalAgents) {
    const harnessType = normalizeHarnessType(agent.name) || agent.type;

    if (!harnessType) {
      continue;
    }

    // Check if this harness type is available locally
    const isAvailable = harnessType === 'codex' ? localStatus.codex.available
      : harnessType === 'claude' ? localStatus.claude.available
      : true;

    if (!isAvailable) {
      continue;
    }

    const hostname = agent.hostname || 'localhost';
    const hostnameShort = hostname.split('.')[0];
    const displayName = agent.userNickname || agent.name;

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
  if (platformLocalAgents.length === 0) {
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
  }

  for (const gateway of gateways) {
    for (const agent of gateway.agents) {
      const harnessType =
        normalizeHarnessType(agent.runtimeAgentId) ||
        normalizeHarnessType(agent.name) ||
        normalizeHarnessType(agent.type);

      if (!harnessType) {
        continue;
      }

      // Use nickname as display name if set
      const displayName = agent.userNickname || agent.name;
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

  return options;
};
