/**
 * Real Agents Integration
 * 
 * Unified interface for executing real coding agents (Codex, Claude Code, etc.)
 */

export * from './codex-agent';
export * from './claude-agent';

import { executeCodexTask, isCodexAvailable, getCodexVersion } from './codex-agent';
import { executeClaudeTask, isClaudeAvailable, getClaudeVersion } from './claude-agent';

export interface RealAgentTask {
  id: string;
  name: string;
  description?: string;
}

export interface RealAgentResult {
  agentType: 'codex' | 'claude';
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
}

/**
 * Execute task using available real agents
 */
export const executeRealAgentTask = async (
  task: RealAgentTask,
  agentType: 'codex' | 'claude' | 'auto'
): Promise<RealAgentResult> => {
  if (agentType === 'auto') {
    // Auto-select best available agent
    const [codexAvailable, claudeAvailable] = await Promise.all([
      isCodexAvailable(),
      isClaudeAvailable(),
    ]);

    if (claudeAvailable) {
      agentType = 'claude';
    } else if (codexAvailable) {
      agentType = 'codex';
    } else {
      return {
        agentType: 'claude',
        success: false,
        error: 'No real agents available. Please install Codex or Claude Code.',
        executionTime: 0,
      };
    }
  }

  try {
    if (agentType === 'codex') {
      const result = await executeCodexTask(task);
      return {
        agentType: 'codex',
        ...result,
      };
    } else {
      const result = await executeClaudeTask(task);
      return {
        agentType: 'claude',
        ...result,
      };
    }
  } catch (error) {
    return {
      agentType,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: 0,
    };
  }
};

/**
 * Get status of all real agents
 */
export const getRealAgentsStatus = async (): Promise<{
  codex: { available: boolean; version?: string };
  claude: { available: boolean; version?: string };
  'claude-haha': { available: boolean; version?: string };
}> => {
  const [codexAvailable, claudeAvailable, claudeHahaAvailable] = await Promise.all([
    isCodexAvailable(),
    isClaudeAvailable('claude'),
    isClaudeAvailable('claude-haha'),
  ]);

  const [codexVersion, claudeVersion, claudeHahaVersion] = await Promise.all([
    codexAvailable ? getCodexVersion() : Promise.resolve(undefined),
    claudeAvailable ? getClaudeVersion('claude') : Promise.resolve(undefined),
    claudeHahaAvailable ? getClaudeVersion('claude-haha') : Promise.resolve(undefined),
  ]);

  return {
    codex: { available: codexAvailable, version: codexVersion },
    claude: { available: claudeAvailable, version: claudeVersion },
    'claude-haha': { available: claudeHahaAvailable, version: claudeHahaVersion },
  };
};

/**
 * Register a real agent in the database
 */
export const registerRealAgent = async (
  name: string,
  type: 'codex' | 'claude' | 'claude-haha',
  location: 'local' | 'remote' | 'cloud' = 'local'
): Promise<{
  id: string;
  name: string;
  type: string;
  location: string;
  status: string;
}> => {
  // Import prisma directly for server-side registration
  const { prisma } = await import('@/lib/prisma');
  
  const agent = await prisma.agent.create({
    data: {
      name,
      type,
      location,
      capabilities: JSON.stringify(['coding', 'analysis', 'review']),
      status: 'online',
    },
  });
  
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    location: agent.location || 'local',
    status: agent.status,
  };
};
