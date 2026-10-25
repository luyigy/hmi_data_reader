import { createHash } from 'node:crypto';
import { isRecord } from './implementation-result';

export type TaskInput = { repository: string; commit: string; sourcePath: string; executions: string[]; resultsDirectories: string[];
  projectEnvPath: string | null; pythonExecutable: string | null; dependencyPaths: string[]; quality: string[];
  replacement?: { eventId: string; previousCommit: string } };
export type TaskInputManifest = { version: 1; executionId: string; primaryRepository: string; inputs: TaskInput[]; ticketInputs?: { executionId: string; commit: string | null }[]; hash: string };

export function parseInputManifest(value: unknown): TaskInputManifest {
  // Payloads originate only in this module; compare the immutable digest before using any stored paths.
  if (!isRecord(value) || value.version !== 1 || typeof value.executionId !== 'string' || typeof value.primaryRepository !== 'string' ||
      !Array.isArray(value.inputs) || typeof value.hash !== 'string') throw new Error('固定输入清单无效');
  const inputs: TaskInput[] = value.inputs.map(input => {
    if (!isRecord(input) || typeof input.repository !== 'string' || typeof input.commit !== 'string' || typeof input.sourcePath !== 'string' ||
      !Array.isArray(input.executions) || !input.executions.every(x => typeof x === 'string') || !Array.isArray(input.resultsDirectories) || !input.resultsDirectories.every(x => typeof x === 'string') ||
      !Array.isArray(input.dependencyPaths) || !input.dependencyPaths.every(x => typeof x === 'string') || !Array.isArray(input.quality) || !input.quality.every(x => typeof x === 'string') ||
      !(input.projectEnvPath === null || typeof input.projectEnvPath === 'string') || !(input.pythonExecutable === null || typeof input.pythonExecutable === 'string')) throw new Error('固定输入条目无效');
    const replacement = input.replacement;
    if (replacement !== undefined && (!isRecord(replacement) || typeof replacement.eventId !== 'string' ||
        typeof replacement.previousCommit !== 'string')) throw new Error('固定候选来源无效');
    return { repository: input.repository, commit: input.commit, sourcePath: input.sourcePath, executions: input.executions, resultsDirectories: input.resultsDirectories,
      projectEnvPath: input.projectEnvPath, pythonExecutable: input.pythonExecutable, dependencyPaths: input.dependencyPaths, quality: input.quality,
      ...(isRecord(replacement) ? { replacement: { eventId: String(replacement.eventId), previousCommit: String(replacement.previousCommit) } } : {}) };
  });
  const manifest: TaskInputManifest = { version: 1, executionId: value.executionId, primaryRepository: value.primaryRepository, inputs, ...(Array.isArray(value.ticketInputs) ? { ticketInputs: value.ticketInputs.map(item => { if (!isRecord(item) || typeof item.executionId !== 'string' || typeof item.commit !== 'string') throw new Error('整票输入提交无效'); return { executionId: item.executionId, commit: item.commit }; }) } : {}), hash: value.hash };
  const { hash, ...content } = manifest;
  if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== hash) throw new Error('固定输入清单摘要不一致');
  return manifest;
}
