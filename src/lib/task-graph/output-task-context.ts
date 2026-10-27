import { graphResourceJobs } from './graph-association';
import { priorOutputArtifacts } from './prior-output-artifacts';
import { prisma } from '../prisma';
import { prepareGraphOutputRuntime } from './output-runtime';

async function previousOutputContext(ownerId: string | undefined, directory: string) {
  const prior = ownerId ? await prisma.taskGraphEvent.findMany({ where: { nodeId: ownerId, kind: 'output_runtime_prepared' }, orderBy: { createdAt: 'asc' }, select: { id: true, payload: true } }) : [];
  const archives = ownerId ? await prisma.taskGraphEvent.findMany({ where: { nodeId: ownerId, kind: 'validation_workspace_cleaned' }, orderBy: { createdAt: 'desc' }, select: { payload: true } }) : [];
  const artifacts = ownerId ? await priorOutputArtifacts(ownerId, directory, prior, archives) : [];
  return { priorArtifacts: artifacts, readOnlyPaths: Array.from(new Set(artifacts.map(artifact => artifact.directory))) };
}

/** Readiness probes reuse scratch space, never publish it as a delivery artifact. */
export async function prepareGraphInspectionOutputForTask(taskId: string, executionId: string) {
  const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, select: { nodeId: true, childTaskId: true } });
  if (job.childTaskId !== taskId) throw new Error('Inspection output task does not own execution');
  const result = await prepareGraphOutputRuntime(job.nodeId, `conditions:${executionId}`, []);
  return { ...result, ...await previousOutputContext(job.nodeId, result.directory) };
}

export async function prepareGraphOutputForTask(taskId: string | undefined, attempt: string, workspaces: string[]) {
  const jobs = taskId ? await graphResourceJobs(taskId) : [];
  const ownerId = jobs[0]?.nodeId;
  const result = await prepareGraphOutputRuntime(ownerId || `check:${workspaces.join(':')}`, attempt, workspaces);
  const node = ownerId ? await prisma.taskGraphNode.findUnique({ where: { id: ownerId }, select: { runId: true } }) : null;
  const { priorArtifacts, readOnlyPaths: previousOutputs } = await previousOutputContext(ownerId, result.directory);
  if (node) await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: `output:${ownerId}:${attempt}` } }, create: { runId: node.runId, nodeId: ownerId, idempotencyKey: `output:${ownerId}:${attempt}`, kind: 'output_runtime_prepared', payload: { attempt, taskId: taskId || null, directory: result.directory, mappings: JSON.parse(result.env.AP_GRAPH_OUTPUT_PATHS_JSON) } }, update: {} });
  return { ...result, priorArtifacts, readOnlyPaths: previousOutputs, env: { ...result.env, AP_GRAPH_PRIOR_OUTPUTS_JSON: JSON.stringify(previousOutputs) }, instructions: result.instructions + `\n先前阶段只读产物目录：${JSON.stringify(previousOutputs)}。需要复用夹具或证据时从这里读取，当前阶段结果写本次目录。` };
}
