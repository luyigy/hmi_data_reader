/**
 * Real Agents Integration
 * 
 * Unified interface for executing real coding agents (Codex, Claude Code, etc.)
 */

export * from './codex-agent';
export * from './claude-agent';
export * from './deepseek-agent';
export * from './gemini-cli-agent';
export * from './pi-agent';

import { getLocalHarnessStatusMap } from '@/lib/harness';
import { executeCodexTask, isCodexAvailable, getCodexVersion } from './codex-agent';
import { executeClaudeTask, isClaudeAvailable, getClaudeVersion } from './claude-agent';
import { executeDeepSeekTask, isDeepSeekAvailable, getDeepSeekVersion } from './deepseek-agent';
import { executeGeminiTask, isGeminiAvailable, getGeminiVersion } from './gemini-cli-agent';
import { executePiAgentTask, isPiAgentAvailable, getPiAgentVersion } from './pi-agent';

export interface RealAgentTask {
  id: string;
  name: string;
  description?: string;
}

export interface RealAgentResult {
  agentType: 'codex' | 'claude' | 'deepseek' | 'gemini-cli' | 'pi-agent';
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
  agentType: 'codex' | 'claude' | 'deepseek' | 'gemini-cli' | 'pi-agent' | 'auto'
): Promise<RealAgentResult> => {
  if (agentType === 'auto') {
    // Auto-select best available agent
    const [codexAvailable, claudeAvailable, deepSeekAvailable, geminiAvailable, piAgentAvailable] = await Promise.all([
      isCodexAvailable(),
      isClaudeAvailable(),
      isDeepSeekAvailable(),
      isGeminiAvailable(),
      isPiAgentAvailable(),
    ]);

    if (claudeAvailable) {
      agentType = 'claude';
    } else if (codexAvailable) {
      agentType = 'codex';
    } else if (geminiAvailable) {
      agentType = 'gemini-cli';
    } else if (deepSeekAvailable) {
      agentType = 'deepseek';
    } else if (piAgentAvailable) {
      agentType = 'pi-agent';
    } else {
      return {
        agentType: 'claude',
        success: false,
        error: 'No real agents available. Please install Codex, Claude Code, or DeepSeek-TUI.',
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
    } else if (agentType === 'gemini-cli') {
      const result = await executeGeminiTask(task);
      return {
        agentType: 'gemini-cli',
        ...result,
      };
    } else if (agentType === 'deepseek') {
      const result = await executeDeepSeekTask(task);
      return {
        agentType: 'deepseek',
        ...result,
      };
    } else if (agentType === 'pi-agent') {
      const result = await executePiAgentTask(task);
      return {
        agentType: 'pi-agent',
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
  deepseek: { available: boolean; version?: string };
  'gemini-cli': { available: boolean; version?: string };
  'pi-agent': { available: boolean; version?: string };
}> => {
  const adapterStatusMap = await getLocalHarnessStatusMap();

  if (adapterStatusMap.codex && adapterStatusMap.claude && adapterStatusMap['claude-haha']
    && adapterStatusMap.deepseek && adapterStatusMap['gemini-cli'] && adapterStatusMap['pi-agent']) {
    return {
      codex: adapterStatusMap.codex,
      claude: adapterStatusMap.claude,
      'claude-haha': adapterStatusMap['claude-haha'],
      deepseek: adapterStatusMap.deepseek,
      'gemini-cli': adapterStatusMap['gemini-cli'],
      'pi-agent': adapterStatusMap['pi-agent'],
    };
  }

  const [codexAvailable, claudeAvailable, claudeHahaAvailable, deepSeekAvailable, geminiAvailable, piAgentAvailable] = await Promise.all([
    isCodexAvailable(),
    isClaudeAvailable('claude'),
    isClaudeAvailable('claude-haha'),
    isDeepSeekAvailable(),
    isGeminiAvailable(),
    isPiAgentAvailable(),
  ]);

  const [codexVersion, claudeVersion, claudeHahaVersion, deepSeekVersion, geminiVersion, piAgentVersion] = await Promise.all([
    codexAvailable ? getCodexVersion() : Promise.resolve(undefined),
    claudeAvailable ? getClaudeVersion('claude') : Promise.resolve(undefined),
    claudeHahaAvailable ? getClaudeVersion('claude-haha') : Promise.resolve(undefined),
    deepSeekAvailable ? getDeepSeekVersion() : Promise.resolve(undefined),
    geminiAvailable ? getGeminiVersion() : Promise.resolve(undefined),
    piAgentAvailable ? getPiAgentVersion() : Promise.resolve(undefined),
  ]);

  return {
    codex: { available: codexAvailable, version: codexVersion },
    claude: { available: claudeAvailable, version: claudeVersion },
    'claude-haha': { available: claudeHahaAvailable, version: claudeHahaVersion },
    deepseek: { available: deepSeekAvailable, version: deepSeekVersion },
    'gemini-cli': { available: geminiAvailable, version: geminiVersion },
    'pi-agent': { available: piAgentAvailable, version: piAgentVersion },
  };
};

/**
 * Register a real agent in the database
 */
export const registerRealAgent = async (
  name: string,
  type: 'codex' | 'claude' | 'claude-haha' | 'deepseek' | 'gemini-cli' | 'pi-agent',
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
