import { assertRuntimeResourcesUnchanged, RuntimePreparationError, type PreparedRuntime } from './runtime-preflight';
import type { AttemptService } from './service-contract';
import { graphWriterEnvironment } from './writer-ownership';
import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma';
import type { GraphDefinition } from './domain';
import { prepareUpstreamInputs } from './upstream-inputs';
import { validationRuntimeDirectory } from './acceptance-runtime';
import { withAttemptServices, type ServiceContext } from './attempt-services';

/** Checks and native roles use one owner; conversation-only reads do not start business processes. */
export async function withGraphTaskServices<T>(taskId: string | undefined, taskRunId: string, action: (context: ServiceContext) => Promise<T>, runtime?: PreparedRuntime | null): Promise<T> {
  const controller = new AbortController();
  const resources = runtime?.verifiedResources || [];
  const postgres = Array.from(new Map(resources.filter(item => item.kind === 'PostgreSQL').map(item => [item.sha256, item])).values());
  const use = async (context: ServiceContext) => {
    await assertRuntimeResourcesUnchanged(resources);
    return action(context);
  };
  if (postgres.length && (!taskId || taskId.startsWith('task-graph-discussion-'))) throw new RuntimePreparationError('invalid', 'PostgreSQL 阶段服务需要任务图执行归属', postgres.map(item => item.path));
  if (!taskId || taskId.startsWith('task-graph-discussion-')) return use({ env: {}, signal: controller.signal, receipts: [] });
  const nodeId = /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId)?.[1];
  const jobs = await prisma.taskGraphExecution.findMany({ where: nodeId ? { nodeId } : { childTaskId: taskId }, include: { node: { include: { run: true } } } });
  if (!jobs.length) {
    if (postgres.length) throw new RuntimePreparationError('invalid', 'PostgreSQL 阶段服务缺少执行账本', postgres.map(item => item.path));
    return use({ env: {}, signal: controller.signal, receipts: [] });
  }
  const node = jobs[0].node;
  const graph = node.run.snapshot as unknown as GraphDefinition;
  const services: AttemptService[] = [...(graph.nodes.find(item => item.key === node.key)?.services || []), ...postgres.map(item => ({
    key: `postgres-${item.sha256.slice(0, 16)}`, runtime: 'postgres' as const,
    resource: { kind: 'path' as const, path: item.path, sha256: item.sha256 },
  }))];
  if (!services.length) return use({ env: {}, signal: controller.signal, receipts: [] });
  const prepared = services.some(service => service.runtime !== 'postgres') ? await Promise.all(jobs.map(job => prepareUpstreamInputs(job.id))) : [];
  const attempt = randomUUID();
  const writer = await graphWriterEnvironment(taskRunId);
  return withAttemptServices({ writerNonce: writer.AP_GRAPH_WRITER_NONCE, services, manifests: prepared.map(input => input.manifest), directory: validationRuntimeDirectory(node.id),
    record: async (kind, payload) => { await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id,
      kind, idempotencyKey: `services:${attempt}:${kind}`, payload: JSON.parse(JSON.stringify({ ...payload, taskId, taskRunId, attempt })) } }); } }, use);
}
