import type { HarnessAdapter, HarnessAvailability } from './types';
import { antigravityHarnessAdapter } from './adapters/antigravity';
import { claudeHahaHarnessAdapter, claudeHarnessAdapter } from './adapters/claude';
import { codexHarnessAdapter } from './adapters/codex';
import { deepSeekHarnessAdapter } from './adapters/deepseek';
import { geminiCliHarnessAdapter } from './adapters/gemini-cli';
import { kimiCodeHarnessAdapter } from './adapters/kimi-code';
import { piAgentHarnessAdapter } from './adapters/pi-agent';

const harnessAdapters = [
  antigravityHarnessAdapter,
  codexHarnessAdapter,
  claudeHarnessAdapter,
  claudeHahaHarnessAdapter,
  deepSeekHarnessAdapter,
  geminiCliHarnessAdapter,
  kimiCodeHarnessAdapter,
  piAgentHarnessAdapter,
] as const satisfies readonly HarnessAdapter[];

const registry = new Map<string, HarnessAdapter>(
  harnessAdapters.map((adapter) => [adapter.type, adapter])
);

export const getHarnessAdapter = (type: string | null | undefined) =>
  type ? registry.get(type) : undefined;

export const listHarnessAdapters = () => Array.from(registry.values());

export const getLocalHarnessStatusMap = async (): Promise<Record<string, HarnessAvailability>> => {
  const pairs = await Promise.all(
    listHarnessAdapters().map(async (adapter) => [adapter.type, await adapter.checkAvailability()] as const)
  );

  return Object.fromEntries(pairs);
};
