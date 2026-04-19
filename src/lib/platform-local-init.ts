/**
 * Platform Local Agents Initialization
 *
 * Ensures that platform local agents (Claude, Codex) exist in the database
 * with the current server's hostname for differentiation across multiple servers.
 */

import { prisma } from './prisma';
import * as os from 'os';

export interface PlatformLocalAgent {
  id: string;
  name: string;
  type: string;
  hostname: string;
  displayName: string;
  emojiIcon: string;
  colorTag: string;
}

/**
 * Get the current server's hostname
 */
export function getServerHostname(): string {
  return os.hostname() || 'localhost';
}

/**
 * Ensure platform local agents exist in the database
 * Called on server startup to guarantee the agents are available
 */
export async function ensurePlatformLocalAgents(): Promise<PlatformLocalAgent[]> {
  const hostname = getServerHostname();
  const agents: PlatformLocalAgent[] = [];

  // Define platform local agents
  const agentDefinitions = [
    {
      name: 'claude',
      type: 'claude',
      emojiIcon: '🤖',
      colorTag: '#4A90E2',
    },
    {
      name: 'claude-haha',
      type: 'claude-haha',
      emojiIcon: '😄',
      colorTag: '#F5A623',
    },
    {
      name: 'codex',
      type: 'codex',
      emojiIcon: '💻',
      colorTag: '#50E3C2',
    },
  ];

  for (const def of agentDefinitions) {
    // Generate a unique ID based on hostname
    const agentId = `platform-local:${hostname}:${def.name}`;

    // Upsert the agent
    const agent = await prisma.agent.upsert({
      where: { id: agentId },
      create: {
        id: agentId,
        name: def.name,
        type: def.type,
        location: '本地', // Platform local agents are local
        hostname,
        capabilities: '[]',
        status: 'online',
        gatewayId: null, // platform_local agents have no gateway
        userNickname: null,
        roleDescription: null,
        emojiIcon: def.emojiIcon,
        colorTag: def.colorTag,
      },
      update: {
        // Update hostname in case it changed
        hostname,
        status: 'online',
        emojiIcon: def.emojiIcon,
        colorTag: def.colorTag,
      },
    });

    agents.push({
      id: agent.id,
      name: agent.name,
      type: agent.type,
      hostname: agent.hostname || hostname,
      displayName: `${def.type.charAt(0).toUpperCase() + def.type.slice(1)} (${hostname.split('.')[0]})`,
      emojiIcon: agent.emojiIcon || def.emojiIcon,
      colorTag: agent.colorTag || def.colorTag,
    });
  }

  return agents;
}

/**
 * Get all platform local agents (across all servers)
 */
export async function getAllPlatformLocalAgents() {
  return prisma.agent.findMany({
    where: {
      hostname: { not: null }, // Agents with hostname are platform_local
    },
    orderBy: [
      { hostname: 'asc' },
      { name: 'asc' },
    ],
  });
}

/**
 * Get platform local agents for the current server only
 */
export async function getLocalPlatformAgents() {
  const hostname = getServerHostname();
  return prisma.agent.findMany({
    where: {
      hostname,
    },
  });
}

/**
 * Generate the agent key for platform local agents
 * Format: platform_local:{hostname}:{type}
 */
export function generatePlatformLocalAgentKey(type: string, hostname?: string): string {
  const hn = hostname || getServerHostname();
  return `platform_local:${hn}:${type}`;
}
