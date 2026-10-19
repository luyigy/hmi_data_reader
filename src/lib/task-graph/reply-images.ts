import path from 'node:path';
import { validationRuntimeDirectory } from './acceptance-runtime';
import { prisma } from '../prisma';
import { replyImagePaths } from '../feishu-card-markdown';
import { deliverTaskImage } from '../project-capabilities/image-delivery';
import { projectCapabilityContext } from '../project-capabilities/context';
import { taskCapabilityRepositories } from '../project-capabilities/task-runtime';
import { publicationDirectory } from '../project-capabilities/runtime';
import { graphMaterialPathsForTask } from './conversation-materials';
import { graphValidationArchiveForTask } from './validation-archive-access';

export async function deliverRunReplyImages(taskRunId: string, content: string, target: Parameters<typeof deliverTaskImage>[0]['target']) {
  const images = replyImagePaths(content);
  if (!images.length) return [];
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { task: true } });
  if (!['completed', 'failed', 'interrupted', 'stopped'].includes(run.status)) return [];
  const job = await prisma.taskGraphExecution.findUnique({ where: { childTaskId: run.taskId } });
  const workspace = job?.worktreePath || run.task.workingDirectory;
  if (!workspace) throw new Error('图片任务缺少绑定工作区');
  const projects = await taskCapabilityRepositories(run.taskId);
  const contexts = (await Promise.all(projects.map(project => projectCapabilityContext({ taskId: run.taskId, workspace, taskRunId: run.id, executionId: project.id })))).filter(context => context !== null);
  const archive = await graphValidationArchiveForTask(run.taskId);
  const ownerId = job?.nodeId || /^task-graph-(?:review|architecture)-(.+)$/.exec(run.taskId)?.[1];
  const outputs = ownerId ? await prisma.taskGraphEvent.findMany({ where: { nodeId: ownerId, kind: 'output_runtime_prepared' } }) : [];
  const outputRoots = outputs.flatMap(event => {
    const row = event.payload;
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.taskId !== run.taskId || typeof row.attempt !== 'string' ||
      !row.attempt.startsWith(`harness:${run.id}:`) || typeof row.directory !== 'string') return [];
    return path.dirname(row.directory) === validationRuntimeDirectory(ownerId!) ? [row.directory] : [];
  });
  const roots = [workspace, ...outputRoots, ...(archive ? [archive] : []), ...await graphMaterialPathsForTask(run.taskId),
    ...contexts.flatMap(context => [publicationDirectory(context, run.taskId), ...context.policy.readOnlyRoots])];
  const receipts: string[] = [];
  if (images.length > 8) throw new Error('单轮回复最多展示8张图片');
  for (const image of images) {
    for (const context of contexts) {
      const latest = await projectCapabilityContext({ taskId: run.taskId, workspace, taskRunId: run.id, executionId: context.job?.id });
      if (!latest || latest.policy.hash !== context.policy.hash) throw new Error('图片发送前项目授权已改变');
    }
    const id = await deliverTaskImage({ taskId: run.taskId, taskRunId: run.id, path: path.resolve(workspace, image), roots, target });
    if (id) receipts.push(id);
  }
  return receipts;
}
