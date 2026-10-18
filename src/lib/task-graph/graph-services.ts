import { graphWriterEnvironment } from './writer-ownership';
import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma';
import type { GraphDefinition } from './domain';
import { prepareUpstreamInputs } from './upstream-inputs';
import { validationRuntimeDirectory } from './acceptance-runtime';
import { withAttemptServices, type ServiceContext } from './attempt-services';

/** Checks and native roles use one owner; conversation-only reads do not start business processes. */
export async function withGraphTaskServices<T>(taskId: string | undefined, taskRunId: string, action: (context: ServiceContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  if (!taskId || taskId.startsWith('task-graph-discussion-')) return action({ env: {}, signal: controller.signal, receipts: [] });
  const nodeId = /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId)?.[1];
  const jobs = await prisma.taskGraphExecution.findMany({ where: nodeId ? { nodeId } : { childTaskId: taskId }, include: { node: { include: { run: true } } } });
  if (!jobs.length) return action({ env: {}, signal: controller.signal, receipts: [] });
  const node = jobs[0].node;
  const graph = node.run.snapshot as unknown as GraphDefinition;
  const services = graph.nodes.find(item => item.key === node.key)?.services || [];
  if (!services.length) return action({ env: {}, signal: controller.signal, receipts: [] });
  const prepared = await Promise.all(jobs.map(job => prepareUpstreamInputs(job.id)));
  const attempt = randomUUID();
  const writer = await graphWriterEnvironment(taskRunId);
  return withAttemptServices({ writerNonce: writer.AP_GRAPH_WRITER_NONCE, services, manifests: prepared.map(input => input.manifest), directory: validationRuntimeDirectory(node.id),
    record: async (kind, payload) => { await prisma.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id,
      kind, idempotencyKey: `services:${attempt}:${kind}`, payload: JSON.parse(JSON.stringify({ ...payload, taskId, taskRunId, attempt })) } }); } }, action);
}
