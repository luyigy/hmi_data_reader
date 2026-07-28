import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseLongFileDetectorConfig } from '@/lib/scheduled-jobs/long-file-detector';
import { loadProjectsConfig, type ProjectConfig } from '@/lib/scheduled-jobs/project-config';
import type { AcpxExecutionBackend } from './types';

export type LongFileRuntimeContext = {
  projectId: string;
  projectPath: string;
  head: string;
  threshold: number;
  extensions: Set<string>;
  excludes: string[];
  baseline: Record<string, number>;
  offenders: Array<{ path: string; lines: number }>;
};

type RuntimeContextOptions = {
  executionBackend: AcpxExecutionBackend;
  workingDirectory?: string;
  projectsFile?: string;
  workspaceRoots?: string[];
};

const gitHead = (cwd: string) => new Promise<string>((resolve, reject) => {
  execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message));
    else resolve(stdout.trim());
  });
});

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const countLines = (content: Buffer) => content.length
  ? content.toString().split('\n').length - Number(content.at(-1) === 10)
  : 0;

const scan = async (
  root: string,
  directory: string,
  extensions: Set<string>,
  excludes: string[],
  files: Record<string, number> = {},
): Promise<Record<string, number>> => {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    if (excludes.some((prefix) => relativePath.startsWith(prefix))) continue;
    if (entry.isDirectory()) await scan(root, filePath, extensions, excludes, files);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files[relativePath] = countLines(await fs.readFile(filePath));
  }
  return files;
};

const detectorFor = (project: ProjectConfig) => project.jobs.find((job) => job.enabled && job.type === 'long_file_detector');

export const getLongFileRuntimeContext = async ({
  executionBackend,
  workingDirectory,
  projectsFile = path.join(process.cwd(), 'config/projects.yaml'),
  workspaceRoots,
}: RuntimeContextOptions): Promise<LongFileRuntimeContext | null> => {
  if (executionBackend !== 'platform_local' || !workingDirectory) return null;
  const resolvedWorkingDirectory = await fs.realpath(workingDirectory).catch(() => null);
  if (!resolvedWorkingDirectory) return null;
  const projects = await loadProjectsConfig(projectsFile, workspaceRoots);
  const project = projects.projects.find((candidate) => isWithin(candidate.path, resolvedWorkingDirectory));
  const detector = project && detectorFor(project);
  if (!project || !detector) return null;

  const rules = parseLongFileDetectorConfig(detector.config);
  const baseline = await scan(project.path, project.path, rules.extensions, rules.excludes);
  const offenders = Object.entries(baseline)
    .filter(([, lines]) => lines >= rules.threshold)
    .map(([filePath, lines]) => ({ path: filePath, lines }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    projectId: project.id,
    projectPath: project.path,
    head: await gitHead(project.path),
    threshold: rules.threshold,
    extensions: rules.extensions,
    excludes: rules.excludes,
    baseline,
    offenders,
  };
};

export const assertLongFileRuntimeContext = async (context: LongFileRuntimeContext) => {
  const current = await scan(context.projectPath, context.projectPath, context.extensions, context.excludes);
  const violations = Object.entries(current)
    .filter(([filePath, lineCount]) => lineCount >= context.threshold && lineCount > (context.baseline[filePath] ?? 0))
    .map(([filePath, lineCount]) => `${filePath}: ${context.baseline[filePath] ?? 0} -> ${lineCount}`)
    .sort();
  if (violations.length) {
    throw new Error(`long-file runtime guard blocked growth at ${context.threshold} lines:\n${violations.join('\n')}`);
  }
};

export const longFileRuntimeNotice = (context: LongFileRuntimeContext, limit = 20) => [
  `Long-file baseline: ${context.projectId} @ ${context.head} (threshold ${context.threshold} lines).`,
  ...context.offenders.slice(0, limit).map(({ path: filePath, lines }) => `- ${filePath}: ${lines} lines`),
  ...(context.offenders.length > limit ? [`- … ${context.offenders.length - limit} more`] : []),
].join('\n');
