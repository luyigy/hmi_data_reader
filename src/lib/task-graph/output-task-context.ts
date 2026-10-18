import { priorOutputArtifacts } from './prior-output-artifacts';
import { prisma } from '../prisma';
import { prepareGraphOutputRuntime } from './output-runtime';

export async function prepareGraphOutputForTask(taskId: string | undefined, attempt: string, workspaces: string[]) {
  const nodeId = taskId && /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId)?.[1];
  const job = taskId && !nodeId ? await prisma.taskGraphExecution.findFirst({ where: { childTaskId: taskId }, select: { nodeId: true } }) : null;
  const ownerId = nodeId || job?.nodeId;
  const result = await prepareGraphOutputRuntime(ownerId || `check:${workspaces.join(':')}`, attempt, workspaces);
  const node = ownerId ? await prisma.taskGraphNode.findUnique({ where: { id: ownerId }, select: { runId: true } }) : null;
  const prior = ownerId ? await prisma.taskGraphEvent.findMany({ where: { nodeId: ownerId, kind: 'output_runtime_prepared' }, orderBy: { createdAt: 'asc' }, select: { id: true, payload: true } }) : [];
  const archives = ownerId ? await prisma.taskGraphEvent.findMany({ where: { nodeId: ownerId, kind: 'validation_workspace_cleaned' }, orderBy: { createdAt: 'desc' }, select: { payload: true } }) : [];
  const priorArtifacts = ownerId ? await priorOutputArtifacts(ownerId, result.directory, prior, archives) : [];
  const previousOutputs = Array.from(new Set(priorArtifacts.map(artifact => artifact.directory)));
  if (node) await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: `output:${ownerId}:${attempt}` } }, create: { runId: node.runId, nodeId: ownerId, idempotencyKey: `output:${ownerId}:${attempt}`, kind: 'output_runtime_prepared', payload: { attempt, taskId: taskId || null, directory: result.directory, mappings: JSON.parse(result.env.AP_GRAPH_OUTPUT_PATHS_JSON) } }, update: {} });
  return { ...result, priorArtifacts, readOnlyPaths: previousOutputs, env: { ...result.env, AP_GRAPH_PRIOR_OUTPUTS_JSON: JSON.stringify(previousOutputs) }, instructions: result.instructions + `\n先前阶段只读产物目录：${JSON.stringify(previousOutputs)}。需要复用夹具或证据时从这里读取，当前阶段结果写本次目录。` };
}
