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
}> => {
  const [codexAvailable, claudeAvailable] = await Promise.all([
    isCodexAvailable(),
    isClaudeAvailable(),
  ]);

  const [codexVersion, claudeVersion] = await Promise.all([
    codexAvailable ? getCodexVersion() : Promise.resolve(undefined),
    claudeAvailable ? getClaudeVersion() : Promise.resolve(undefined),
  ]);

  return {
    codex: { available: codexAvailable, version: codexVersion },
    claude: { available: claudeAvailable, version: claudeVersion },
  };
};

/**
 * Register a real agent in the database
 */
export const registerRealAgent = async (
  name: string,
  type: 'codex' | 'claude',
  location: 'local' | 'remote' | 'cloud' = 'local'
): Promise<{
  id: string;
  name: string;
  type: string;
  location: string;
  status: string;
}> => {
  // Call the API to register the agent
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      type: type === 'codex' ? 'coding' : 'coding',
      location,
      capabilities: ['coding', 'analysis', 'review'],
      status: 'online',
    }),
  });

  if (!res.ok) {
    throw new Error('Failed to register agent');
  }

  return await res.json();
};
