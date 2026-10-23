import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { preparePostgresService } from './postgres-service';
import type { AttemptService } from './service-contract';
import type { TaskInputManifest } from './upstream-inputs';

export async function prepareServiceLaunch(service: AttemptService, manifests: TaskInputManifest[], data: string, port: number, signal: AbortSignal) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8',
    AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', AP_SERVICE_DATA_DIR: data, AP_SERVICE_PORT: String(port), AP_SERVICE_HOST: '127.0.0.1' };
  if (service.runtime === 'postgres') return { ...await preparePostgresService(service, data, port, signal), env };
  const candidates = manifests.flatMap(manifest => manifest.inputs.filter(input => input.executions.includes(service.input)).map(input => ({ input, hash: manifest.hash })));
  if (!candidates.length || new Set(candidates.map(({ input }) => `${input.repository}@${input.commit}`)).size !== 1) throw new Error('服务输入未消费或版本不唯一：' + service.input);
  const { input, hash } = candidates[0];
  const entry = await realpath(path.join(input.sourcePath, service.entry));
  if (!entry.startsWith(input.sourcePath + path.sep)) throw new Error('服务入口越出固定源码');
  await mkdir(data, { mode: 0o700 });
  const command = service.runtime === 'python' ? input.pythonExecutable : process.execPath;
  if (!command) throw new Error('前置没有登记 Python 环境：' + service.input);
  const argv = [...(service.runtime === 'python' ? ['-E', '-s', '-B'] : []), entry,
    ...service.args.map(arg => arg.replaceAll('{port}', String(port)).replaceAll('{data}', data))];
  const url = `http://127.0.0.1:${port}`;
  return {
    command, argv, env: { ...env, NODE_PATH: input.dependencyPaths.filter(directory => path.basename(directory) === 'node_modules').join(path.delimiter), AP_PROJECT_REPOSITORY: input.repository },
    readOnlyPaths: [input.sourcePath, ...input.dependencyPaths, ...(input.projectEnvPath ? [input.projectEnvPath] : [])],
    identity: { runtime: service.runtime, input: service.input, commit: input.commit, inputHash: hash, sourcePath: input.sourcePath, entry },
    url,
    healthy: async () => {
      const response = await fetch(url + service.healthPath, { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]), redirect: 'error' });
      const healthy = response.ok; await response.body?.cancel(); return healthy;
    },
    close: async () => {},
  };
}

export type ServiceLaunch = Awaited<ReturnType<typeof prepareServiceLaunch>>;
