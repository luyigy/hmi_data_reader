/**
 * Set Agent Nickname Script
 *
 * Usage:
 *   npx tsx scripts/set-agent-nickname.ts
 *
 * This will list all agents and prompt you to set nicknames.
 */

import { prisma } from '../src/lib/prisma';

interface AgentChoice {
  id: string;
  name: string;
  type: string;
  gatewayName: string | null;
  currentUserNickname: string | null;
}

async function listAgents(): Promise<AgentChoice[]> {
  const agents = await prisma.agent.findMany({
    include: {
      gateway: true,
    },
    orderBy: [
      { gateway: { name: 'asc' } },
      { type: 'asc' },
    ],
  });

  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    type: agent.type,
    gatewayName: agent.gateway?.name || null,
    currentUserNickname: agent.userNickname,
  }));
}

async function setAgentNickname(
  agentId: string,
  nickname: string,
  options: {
    roleDescription?: string;
    emojiIcon?: string;
    colorTag?: string;
  } = {}
) {
  const updated = await prisma.agent.update({
    where: { id: agentId },
    data: {
      userNickname: nickname,
      roleDescription: options.roleDescription,
      emojiIcon: options.emojiIcon,
      colorTag: options.colorTag,
    },
  });

  return updated;
}

async function main() {
  const agents = await listAgents();

  console.log('\n=== Available Agents ===\n');

  agents.forEach((agent, index) => {
    console.log(`${index + 1}. ${agent.gatewayName || 'Platform Local'} - ${agent.type}`);
    console.log(`   ID: ${agent.id}`);
    console.log(`   Current nickname: ${agent.currentUserNickname || '(none)'}`);
    console.log('');
  });

  console.log('\nTo set a nickname, use the API or Prisma Studio:\n');
  console.log('API Example:');
  console.log(`  curl -X PATCH http://localhost:3010/api/agents/{AGENT_ID} \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"userNickname": "小C", "emojiIcon": "🤖"}'`);
  console.log('\nPrisma Studio:');
  console.log('  npx prisma studio');
  console.log('\n');
}

main().catch(console.error);
