import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import type { GraphDefinition } from './domain';
import { readIssueRoute } from './issue-source';
import { trackerRequest, type TrackerRequest } from './issue-tracker';
import { postGraphParentProgress } from './feishu';
import { refreshTaskGraphRunStatus } from './store';

const unavailableUntil = new Map<string, number>();

/** Approval drift blocks only affected future work; an API outage holds dispatch without rerunning agents. */
export async function inspectIssueDispatch(runId: string, definition: GraphDefinition, request: TrackerRequest = trackerRequest) {
  const source = definition.issueSource;
  if (!source) return new Set<string>(); // Historical frozen runs retain their original policy.
  if ((unavailableUntil.get(runId) || 0) > Date.now()) return new Set(definition.nodes.map((node) => node.key));
  let blocked = new Set<string>();
  let kind = 'issue_source_changed'; let detail = '';
  try {
    const current = await readIssueRoute(source.parent, source.repositories, request);
    unavailableUntil.delete(runId);
    if (current.source.hash === source.hash) return blocked;
    for (const ticket of source.tickets) {
      const next = current.source.tickets.find((item) => item.ref === ticket.ref && item.key === ticket.key);
      if (!next || next.hash !== ticket.hash) blocked.add(ticket.key);
    }
    if (!blocked.size || current.source.tickets.length !== source.tickets.length) blocked = new Set(definition.nodes.map((node) => node.key));
    for (let i = 0; i < definition.nodes.length; i++) for (const node of definition.nodes) {
      if (node.dependsOn.some((key) => blocked.has(key))) blocked.add(node.key);
    }
    detail = `Issues 目标或依赖已变化，${Array.from(blocked).join('、')} 的后续派发需重新提审；进行中的任务保留。`;
    await prisma.$transaction(async (tx) => {
      await tx.taskGraphNode.updateMany({ where: { runId, key: { in: Array.from(blocked) }, status: { in: ['ready', 'planned'] } }, data: { status: 'attention' } });
      await tx.taskGraphExecution.updateMany({ where: { node: { runId, key: { in: Array.from(blocked) }, status: 'attention' }, status: { in: ['ready', 'planned'] } }, data: { status: 'attention', issueKind: 'issue_source_changed' } });
    });
    await refreshTaskGraphRunStatus(runId);
  } catch (error) {
    unavailableUntil.set(runId, Date.now() + 30_000);
    kind = 'issue_source_unavailable';
    detail = `暂缓新派发，无法核对 Issue 来源：${error instanceof Error ? error.message : String(error)}。已运行任务不重复启动，平台稍后重查。`;
    blocked = new Set(definition.nodes.map((node) => node.key));
  }
  const key = `issues:dispatch:${createHash('sha256').update(kind + detail).digest('hex')}`;
  const existing = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } } });
  if (!existing) {
    const event = await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } },
      create: { runId, idempotencyKey: key, kind, payload: { detail, blocked: Array.from(blocked) } }, update: {} });
    const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
    await postGraphParentProgress(run.parentTaskId, event.id, detail);
  }
  return blocked;
}
