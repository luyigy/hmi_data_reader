import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

type Rules = { blocking: number; extensions: Set<string>; ignored: Set<string> };
export type LongFileBaseline = { rules: Rules; lines: Record<string, number> };

const readRules = async (cwd: string): Promise<Rules> => {
  const source = await fs.readFile(path.join(cwd, 'docs/workflow/workflow-contract.yaml'), 'utf8');
  const value = parse(source) as { large_files?: { blocking_lines?: unknown; source_extensions?: unknown; ignored_path_parts?: unknown } };
  const config = value.large_files;
  if (!config || !Number.isInteger(config.blocking_lines) || Number(config.blocking_lines) < 1
    || !Array.isArray(config.source_extensions) || !Array.isArray(config.ignored_path_parts)) {
    throw new Error('workflow contract has invalid large_files rules');
  }
  return {
    blocking: Number(config.blocking_lines),
    extensions: new Set(config.source_extensions.map(String)),
    ignored: new Set(config.ignored_path_parts.map(String)),
  };
};

const scan = async (cwd: string, rules: Rules, directory = cwd, files: Record<string, number> = {}) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!rules.ignored.has(entry.name)) await scan(cwd, rules, path.join(directory, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !rules.extensions.has(path.extname(entry.name))) continue;
    const filePath = path.join(directory, entry.name);
    const content = await fs.readFile(filePath);
    files[path.relative(cwd, filePath)] = content.length ? content.toString().split('\n').length - Number(content.at(-1) === 10) : 0;
  }
  return files;
};

export const captureLongFileBaseline = async (cwd: string): Promise<LongFileBaseline> => {
  const rules = await readRules(cwd);
  return { rules, lines: await scan(cwd, rules) };
};

export const longFileNotice = (baseline: LongFileBaseline) => {
  const offenders = Object.entries(baseline.lines).filter(([, lines]) => lines >= baseline.rules.blocking);
  return offenders.length
    ? `\n\nLong-file guard: these files are already at or above ${baseline.rules.blocking} lines and must not grow:\n${offenders.map(([file, lines]) => `- ${file}: ${lines} lines`).join('\n')}`
    : '';
};

export const assertLongFilesDidNotGrow = async (cwd: string, baseline: LongFileBaseline) => {
  const current = await scan(cwd, baseline.rules);
  const violations = Object.entries(current).flatMap(([file, lines]) =>
    lines >= baseline.rules.blocking && (lines > (baseline.lines[file] ?? 0))
      ? [`${file}: ${baseline.lines[file] ?? 0} -> ${lines}`]
      : []);
  if (violations.length) throw new Error(`long-file guard blocked growth at ${baseline.rules.blocking} lines:\n${violations.join('\n')}`);
};
