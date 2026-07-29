/**
 * Real Agents Integration
 * 
 * Unified interface for executing real coding agents (Codex, Claude Code, etc.)
 */

export * from './codex-agent';
export * from './claude-agent';
export * from './deepseek-agent';
export * from './gemini-cli-agent';
export * from './antigravity-agent';
export * from './pi-agent';
export * from './kimi-code-agent';

import { getLocalHarnessStatusMap } from '@/lib/harness';
import { executeCodexTask, isCodexAvailable, getCodexVersion } from './codex-agent';
import { executeClaudeTask, isClaudeAvailable, getClaudeVersion } from './claude-agent';
import { executeDeepSeekTask, isDeepSeekAvailable, getDeepSeekVersion } from './deepseek-agent';
import { executeGeminiTask, isGeminiAvailable, getGeminiVersion } from './gemini-cli-agent';
import { executeAntigravityTask, getAntigravityVersion, isAntigravityAvailable } from './antigravity-agent';
import { executePiAgentTask, isPiAgentAvailable, getPiAgentVersion } from './pi-agent';
import { executeKimiCodeTask, isKimiCodeAvailable, getKimiCodeVersion } from './kimi-code-agent';

export interface RealAgentTask {
  id: string;
  name: string;
  description?: string;
}

export interface RealAgentResult {
  agentType: 'antigravity' | 'codex' | 'claude' | 'deepseek' | 'gemini-cli' | 'pi-agent' | 'kimi-code';
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
  agentType: 'antigravity' | 'codex' | 'claude' | 'deepseek' | 'gemini-cli' | 'pi-agent' | 'kimi-code' | 'auto'
): Promise<RealAgentResult> => {
  if (agentType === 'auto') {
    // Auto-select best available agent
    const [antigravityAvailable, codexAvailable, claudeAvailable, deepSeekAvailable, geminiAvailable, piAgentAvailable, kimiCodeAvailable] = await Promise.all([
      isAntigravityAvailable(),
      isCodexAvailable(),
      isClaudeAvailable(),
      isDeepSeekAvailable(),
      isGeminiAvailable(),
      isPiAgentAvailable(),
      isKimiCodeAvailable(),
    ]);

    if (claudeAvailable) {
      agentType = 'claude';
    } else if (codexAvailable) {
      agentType = 'codex';
    } else if (antigravityAvailable) {
      agentType = 'antigravity';
    } else if (geminiAvailable) {
      agentType = 'gemini-cli';
    } else if (deepSeekAvailable) {
      agentType = 'deepseek';
    } else if (piAgentAvailable) {
      agentType = 'pi-agent';
    } else if (kimiCodeAvailable) {
      agentType = 'kimi-code';
    } else {
      return {
        agentType: 'claude',
        success: false,
        error: 'No supported real agent CLI is available.',
        executionTime: 0,
      };
    }
  }

  try {
    if (agentType === 'antigravity') {
      const result = await executeAntigravityTask(task);
      return {
        agentType: 'antigravity',
        ...result,
      };
    } else if (agentType === 'codex') {
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
    } else if (agentType === 'kimi-code') {
      const result = await executeKimiCodeTask(task, {
        permissionProfile: 'full_access',
      });
      return {
        agentType: 'kimi-code',
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
  antigravity: { available: boolean; version?: string };
  claude: { available: boolean; version?: string };
  'claude-haha': { available: boolean; version?: string };
  deepseek: { available: boolean; version?: string };
  'gemini-cli': { available: boolean; version?: string };
  'pi-agent': { available: boolean; version?: string };
  'kimi-code': { available: boolean; version?: string };
}> => {
  const adapterStatusMap = await getLocalHarnessStatusMap();

  if (adapterStatusMap.antigravity && adapterStatusMap.codex && adapterStatusMap.claude && adapterStatusMap['claude-haha']
    && adapterStatusMap.deepseek && adapterStatusMap['gemini-cli'] && adapterStatusMap['pi-agent']
    && adapterStatusMap['kimi-code']) {
    return {
      antigravity: adapterStatusMap.antigravity,
      codex: adapterStatusMap.codex,
      claude: adapterStatusMap.claude,
      'claude-haha': adapterStatusMap['claude-haha'],
      deepseek: adapterStatusMap.deepseek,
      'gemini-cli': adapterStatusMap['gemini-cli'],
      'pi-agent': adapterStatusMap['pi-agent'],
      'kimi-code': adapterStatusMap['kimi-code'],
    };
  }

  const [antigravityAvailable, codexAvailable, claudeAvailable, claudeHahaAvailable, deepSeekAvailable, geminiAvailable, piAgentAvailable, kimiCodeAvailable] = await Promise.all([
    isAntigravityAvailable(),
    isCodexAvailable(),
    isClaudeAvailable('claude'),
    isClaudeAvailable('claude-haha'),
    isDeepSeekAvailable(),
    isGeminiAvailable(),
    isPiAgentAvailable(),
    isKimiCodeAvailable(),
  ]);

  const [antigravityVersion, codexVersion, claudeVersion, claudeHahaVersion, deepSeekVersion, geminiVersion, piAgentVersion, kimiCodeVersion] = await Promise.all([
    antigravityAvailable ? getAntigravityVersion() : Promise.resolve(undefined),
    codexAvailable ? getCodexVersion() : Promise.resolve(undefined),
    claudeAvailable ? getClaudeVersion('claude') : Promise.resolve(undefined),
    claudeHahaAvailable ? getClaudeVersion('claude-haha') : Promise.resolve(undefined),
    deepSeekAvailable ? getDeepSeekVersion() : Promise.resolve(undefined),
    geminiAvailable ? getGeminiVersion() : Promise.resolve(undefined),
    piAgentAvailable ? getPiAgentVersion() : Promise.resolve(undefined),
    kimiCodeAvailable ? getKimiCodeVersion() : Promise.resolve(undefined),
  ]);

  return {
    antigravity: { available: antigravityAvailable, version: antigravityVersion },
    codex: { available: codexAvailable, version: codexVersion },
    claude: { available: claudeAvailable, version: claudeVersion },
    'claude-haha': { available: claudeHahaAvailable, version: claudeHahaVersion },
    deepseek: { available: deepSeekAvailable, version: deepSeekVersion },
    'gemini-cli': { available: geminiAvailable, version: geminiVersion },
    'pi-agent': { available: piAgentAvailable, version: piAgentVersion },
    'kimi-code': { available: kimiCodeAvailable, version: kimiCodeVersion },
  };
};

/**
 * Register a real agent in the database
 */
export const registerRealAgent = async (
  name: string,
  type: 'antigravity' | 'codex' | 'claude' | 'claude-haha' | 'deepseek' | 'gemini-cli' | 'pi-agent' | 'kimi-code',
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
