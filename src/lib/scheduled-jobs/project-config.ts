import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export const REGISTERED_JOB_TYPES = new Set(['workflow_watcher', 'long_file_detector', 'noop_test']);

export type JobMode = 'shadow' | 'active';

export type JobConfig = {
  id: string;
  type: string;
  schedule: string;
  enabled: boolean;
  mode: JobMode;
  config: Record<string, unknown>;
};

export type ProjectConfig = {
  id: string;
  name: string;
  path: string;
  ref: string;
  feishu: {
    chat_id: string;
    approver_open_ids: string[];
  };
  jobs: JobConfig[];
};

export type ProjectsConfig = { projects: ProjectConfig[] };

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};

const stringArray = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
};

export const validateSchedule = (value: unknown, label: string) => {
  const schedule = string(value, label);
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[\d*/?,\-]+$/.test(field))) {
    throw new Error(`${label} must be a five-field cron expression`);
  }
  return schedule;
};

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function loadProjectsConfig(
  file = path.join(process.cwd(), 'config/projects.yaml'),
  workspaceRoots = (process.env.SCHEDULED_JOB_WORKSPACE_ROOTS || '/data1/code').split(path.delimiter),
): Promise<ProjectsConfig> {
  const source = object(parse(await readFile(file, 'utf8')), 'config');
  if (!Array.isArray(source.projects)) throw new Error('projects must be an array');
  const roots = await Promise.all(workspaceRoots.filter(Boolean).map((root) => realpath(root)));
  const projectIds = new Set<string>();
  const chatIds = new Set<string>();

  const projects = await Promise.all(source.projects.map(async (rawProject, projectIndex) => {
    const raw = object(rawProject, `projects[${projectIndex}]`);
    const id = string(raw.id, `projects[${projectIndex}].id`);
    if (projectIds.has(id)) throw new Error(`duplicate project id: ${id}`);
    projectIds.add(id);

    const projectPath = string(raw.path, `project ${id}.path`);
    if (!path.isAbsolute(projectPath)) throw new Error(`project ${id}.path must be absolute`);
    const resolvedPath = await realpath(projectPath).catch(() => { throw new Error(`project ${id}.path does not exist`); });
    if (!(await stat(resolvedPath)).isDirectory()) throw new Error(`project ${id}.path must be a directory`);
    if (!roots.some((root) => isWithin(root, resolvedPath))) throw new Error(`project ${id}.path is outside allowed workspace roots`);

    const ref = string(raw.ref, `project ${id}.ref`);
    if (!/^refs\/(heads|tags)\/[^\s~^:?*[\\]+$/.test(ref)) throw new Error(`project ${id}.ref is invalid`);

    const feishu = object(raw.feishu, `project ${id}.feishu`);
    const chatId = string(feishu.chat_id, `project ${id}.feishu.chat_id`);
    if (chatIds.has(chatId)) throw new Error(`duplicate feishu chat_id: ${chatId}`);
    chatIds.add(chatId);

    if (!Array.isArray(raw.jobs)) throw new Error(`project ${id}.jobs must be an array`);
    const jobIds = new Set<string>();
    const jobs = raw.jobs.map((rawJob, jobIndex): JobConfig => {
      const job = object(rawJob, `project ${id}.jobs[${jobIndex}]`);
      const jobId = string(job.id, `project ${id}.jobs[${jobIndex}].id`);
      if (jobIds.has(jobId)) throw new Error(`duplicate job id in project ${id}: ${jobId}`);
      jobIds.add(jobId);
      const type = string(job.type, `job ${id}/${jobId}.type`);
      if (!REGISTERED_JOB_TYPES.has(type)) throw new Error(`unknown job type: ${type}`);
      if (typeof job.enabled !== 'boolean') throw new Error(`job ${id}/${jobId}.enabled must be boolean`);
      if (job.mode !== 'shadow' && job.mode !== 'active') throw new Error(`job ${id}/${jobId}.mode must be shadow or active`);
      return {
        id: jobId,
        type,
        schedule: validateSchedule(job.schedule, `job ${id}/${jobId}.schedule`),
        enabled: job.enabled,
        mode: job.mode,
        config: job.config === undefined ? {} : object(job.config, `job ${id}/${jobId}.config`),
      };
    });

    return {
      id,
      name: string(raw.name, `project ${id}.name`),
      path: resolvedPath,
      ref,
      feishu: {
        chat_id: chatId,
        approver_open_ids: stringArray(feishu.approver_open_ids ?? [], `project ${id}.feishu.approver_open_ids`),
      },
      jobs,
    };
  }));

  return { projects };
}

export const findProjectByChatId = (config: ProjectsConfig, chatId: string) =>
  config.projects.find((project) => project.feishu.chat_id === chatId
    || project.jobs.some((job) => job.type === 'workflow_watcher' && job.config.coding_bot_chat_id === chatId));

export const findProjectById = (config: ProjectsConfig, projectId: string) =>
  config.projects.find((project) => project.id === projectId);

export const findJob = (config: ProjectsConfig, projectId: string, jobId: string) =>
  findProjectById(config, projectId)?.jobs.find((job) => job.id === jobId);
