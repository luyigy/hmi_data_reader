import type { JobConfig, JobMode, ProjectConfig } from './project-config';
import { longFileDetectorHandler } from './long-file-detector';
import { workflowWatcherHandler } from './workflow-watcher';

export type JobHandler = (context: {
  project: ProjectConfig;
  job: JobConfig;
  mode: JobMode;
  cursor: unknown;
  signal: AbortSignal;
}) => Promise<{ summary: string; cursor?: unknown }>;

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

export const noopTestHandler: JobHandler = async ({ cursor, job, signal }) => {
  const config = job.config as { delay_ms?: number; fail?: boolean };
  await wait(config.delay_ms ?? 0, signal);
  if (config.fail) throw new Error('noop test failure');
  const runs = typeof cursor === 'object' && cursor && 'runs' in cursor
    ? Number((cursor as { runs: unknown }).runs) + 1
    : 1;
  return { summary: 'noop test completed', cursor: { runs } };
};

export const jobHandlers = new Map<string, JobHandler>([
  ['noop_test', noopTestHandler],
  ['long_file_detector', longFileDetectorHandler],
  ['workflow_watcher', workflowWatcherHandler],
]);
