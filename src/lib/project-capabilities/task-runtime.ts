import { graphResourceJobs } from '../task-graph/graph-association';
import { withProjectCapabilities } from './runtime';

/** Only ledger-bound repositories participate; non-Git role directories never infer a project. */
export async function taskCapabilityRepositories(taskId: string) {
  const jobs = await graphResourceJobs(taskId);
  return jobs.map(job => ({ id: job.id, key: job.key, repository: job.repository }));
}

export async function withTaskProjectCapabilities<T>(args: Parameters<typeof withProjectCapabilities>[0], action: Parameters<typeof withProjectCapabilities<T>>[1]) {
  const projects = await taskCapabilityRepositories(args.taskId);
  if (projects.length <= 1) return withProjectCapabilities({ ...args, executionId: projects[0]?.id }, action);
  const accesses: { key: string; access: Parameters<typeof action>[0] }[] = [];
  const enter = async (index: number): Promise<T> => {
    if (index < projects.length) return withProjectCapabilities({ ...args, executionId: projects[index].id }, async access => {
      accesses.push({ key: projects[index].key, access });
      return enter(index + 1);
    });
    const active = accesses.filter(item => item.access.env.AP_PROJECT_CAPABILITY_SOCKET);
    if (!active.length) return action({ env: {}, readOnlyPaths: [], instructions: '' });
    return action({ env: { AP_PROJECT_CAPABILITIES_JSON: JSON.stringify(active.map(({ key, access }) => ({ key, socket: access.env.AP_PROJECT_CAPABILITY_SOCKET, token: access.env.AP_PROJECT_CAPABILITY_TOKEN }))) },
      readOnlyPaths: Array.from(new Set(active.flatMap(({ access }) => access.readOnlyPaths))),
      instructions: active.map(({ key, access }) => `\n项目 ${key}：${access.instructions}`).join('\n') + '\n多仓命令用 sources 返回的完整别名 <仓内任务键>/<资料源别名>；不可省略仓内任务键。' });
  };
  return enter(0);
}
