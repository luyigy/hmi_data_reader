import { prisma } from '@/lib/prisma';
import { getRealAgentsStatus } from '@/lib/real-agents';
import type { AcpxExecutionBackend } from './types';

export interface GatewayHarnessOption {
  gatewayId: string;
  gatewayName: string;
  executionBackend: AcpxExecutionBackend;
  harnessType: string;
  harnessLabel: string;
  agentId?: string;
  agentName?: string;
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

export const deriveGatewayHarnessOptions = async (): Promise<GatewayHarnessOption[]> => {
  const [gateways, localStatus] = await Promise.all([
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
  ]);

  const options: GatewayHarnessOption[] = [];

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

  for (const gateway of gateways) {
    for (const agent of gateway.agents) {
      const harnessType =
        normalizeHarnessType(agent.runtimeAgentId) ||
        normalizeHarnessType(agent.name) ||
        normalizeHarnessType(agent.type);

      if (!harnessType) {
        continue;
      }

      options.push({
        gatewayId: gateway.id,
        gatewayName: gateway.name,
        executionBackend: 'gateway_openclaw',
        harnessType,
        harnessLabel: `${gateway.name} / ${toTitleCase(harnessType)}`,
        agentId: agent.id,
        agentName: agent.name,
        runtimeAgentId: agent.runtimeAgentId || undefined,
        status: agent.status,
      });
    }
  }

  return options;
};
