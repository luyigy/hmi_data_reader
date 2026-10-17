import { createHash } from 'node:crypto';
import { isRecord } from './implementation-result';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { redactSensitiveText } from '../redact-sensitive';
import type { GraphDefinition } from './domain';
import { assertIssueSource } from './issue-source';
import { resolveRunIssueSource } from './issue-adoption';
import { issueEndpoint, parseIssueRef, readTrackerIssue, trackerPages, trackerRequest, type TrackerRequest } from './issue-tracker';

/** The ledger is the durable outbox. A completed node never needs another agent run to sync its Issue. */
export async function enqueueIssueSync() {
  const nodes = await prisma.taskGraphNode.findMany({ where: { status: { in: ['passed', 'delivered_unverified'] }, OR: [{ run: { snapshot: { path: ['issueSource'], not: Prisma.AnyNull } } }, { run: { events: { some: { kind: 'issue_source_adopted' } } } }] }, include: { run: true, executions: true } });
  for (const node of nodes) {
    const graph = node.run.snapshot as unknown as GraphDefinition;
    const source = graph.issueSource || await resolveRunIssueSource(node.runId);
    const ticket = source?.tickets.find((ticket) => ticket.key === node.key);
    if (!ticket) continue;
    if (node.executions.some((execution) => execution.status !== 'integrated' || !execution.commit)) throw new Error(`Completed node lacks integrated commits: ${node.id}`);
    const legacy = await prisma.taskGraphEvent.findFirst({ where: { nodeId: node.id, kind: 'issue_sync_requested', idempotencyKey: `issues:sync:${node.key}:requested` } });
    if (legacy && !await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_delivery_reclassified', createdAt: { gte: legacy.createdAt } } })) continue;
    const delivery = createHash('sha256').update(JSON.stringify({ status: node.status, executions: node.executions.map(job => ({ id: job.id, taskRunId: job.taskRunId, commit: job.commit })).sort((a,b) => a.id.localeCompare(b.id)) })).digest('hex');
    const idempotencyKey = `issues:sync:${node.key}:${delivery}:requested`;
    await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey } }, create: {
      runId: node.runId, nodeId: node.id, idempotencyKey, kind: 'issue_sync_requested',
      payload: { delivery, ref: ticket.ref, status: node.status, commits: node.executions.map((execution) => ({ repository: execution.repository, commit: execution.commit })),
        evidence: node.evidence as Prisma.InputJsonValue },
    }, update: {} });
  }
}

export async function syncIssueDelivery(eventId: string, request: TrackerRequest = trackerRequest) {
  const event = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: eventId } });
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${event.nodeId} FOR NO KEY UPDATE`;
    return syncCurrentIssueDelivery(eventId, request);
  }, { timeout: 120_000 });
}
async function syncCurrentIssueDelivery(eventId: string, request: TrackerRequest) {
  const event = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: eventId }, include: { run: true, node: true } });
  if (event.kind !== 'issue_sync_requested' || !event.node || !['passed', 'delivered_unverified'].includes(event.node.status)) throw new Error('Issue sync requires approved ledger completion');
  const key = isRecord(event.payload) && typeof event.payload.delivery === 'string' ? `issues:sync:${event.node.key}:${event.payload.delivery}` : `issues:sync:${event.node.key}`;
  const find = (suffix: string) => prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: event.runId, idempotencyKey: key + suffix } } });
  const record = (suffix: string, kind: string, payload: Prisma.InputJsonValue = {}) => prisma.taskGraphEvent.upsert({
    where: { runId_idempotencyKey: { runId: event.runId, idempotencyKey: key + suffix } },
    create: { runId: event.runId, nodeId: event.nodeId, idempotencyKey: key + suffix, kind, payload: { ...(isRecord(payload) ? payload : {}), requestId: event.id } }, update: {} });
  const reclassification = await prisma.taskGraphEvent.findFirst({ where: { nodeId: event.nodeId, kind: 'node_delivery_reclassified', createdAt: { gte: event.createdAt } } });
  const payloadValue = event.payload;
  const deliveredCommits = isRecord(payloadValue) && Array.isArray(payloadValue.commits) ? payloadValue.commits : [];
  const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: event.node.id } });
  if (reclassification || !isRecord(payloadValue) || payloadValue.status !== event.node.status || !Array.isArray(payloadValue.commits) ||
      jobs.some(job => !deliveredCommits.some(item => isRecord(item) && item.repository === job.repository && item.commit === job.commit))) {
    await record(':superseded', 'issue_sync_superseded', { requestId: event.id }); return 'superseded';
  }
  if (await find(':completed')) return 'completed';
  const graph = event.run.snapshot as unknown as GraphDefinition;
  await assertIssueSource(graph.issueSource || await resolveRunIssueSource(event.runId), request);
  const payload = event.payload as { ref: string; status: string; commits: { repository: string; commit: string }[]; evidence: unknown };
  const ref = parseIssueRef(payload.ref);
  const endpoint = issueEndpoint(ref);
  const marker = `<!-- ap-delivery:${event.runId}:${event.node.key}:${event.id} -->`;
  const comments = await trackerPages(ref.provider, endpoint + '/comments', request);
  let comment = comments.find((value) => value && typeof value === 'object' && 'body' in value && typeof value.body === 'string' && value.body.includes(marker));
  if (!comment) {
    // Commit send intent before HTTP. A crash after remote acceptance must never blindly POST again.
    try {
      await prisma.taskGraphEvent.create({ data: { runId: event.runId, nodeId: event.nodeId,
        idempotencyKey: key + ':comment-attempted', kind: 'issue_sync_comment_attempted', payload: {} } });
    } catch (error) {
      if (await find(':comment-attempted')) {
        await record(':uncertain', 'issue_sync_uncertain', { note: '评论发送结果不确定，回读未发现标记。保留账本，未重复发送，请核对 tracker。' });
        return 'uncertain';
      }
      throw error;
    }
    const body = redactSensitiveText(`${marker}\n## 平台交付回执\n\n运行 ${event.runId} / ${event.node.key}\n结果：${payload.status === 'delivered_unverified' ? '已交付，未验收（批准的仅实施模式）' : '批准的检查与验收已通过'}\n\n` +
      payload.commits.map((item) => `${item.repository}: ${item.commit}`).join('\n') + '\n\n```json\n' + JSON.stringify(payload.evidence, null, 2).slice(0, 20_000) + '\n```');
    comment = await request(ref.provider, endpoint + '/comments', 'POST', { body });
    const confirmed = await trackerPages(ref.provider, endpoint + '/comments', request);
    comment = confirmed.find((value) => value && typeof value === 'object' && 'body' in value && typeof value.body === 'string' && value.body.includes(marker));
    if (!comment) {
      await record(':uncertain', 'issue_sync_uncertain', { note: '已发送评论但尚无回读回执，稍后只对账，不重复发送。' });
      return 'uncertain';
    }
  }
  if (!comment || typeof comment !== 'object' || !('id' in comment) || !['string', 'number'].includes(typeof comment.id)) throw new Error('Issue comment receipt has no ID');
  const commentId = String(comment.id);
  await record(':comment-recorded', 'issue_sync_comment_recorded', { commentId });
  const current = await readTrackerIssue(payload.ref, request);
  // The close operation is idempotent. Remote close never feeds back into execution gates.
  if (!['closed', '已关闭'].includes(current.state)) {
    const closePath = ref.provider === 'gitee' ? `/repos/${ref.owner}/issues/${ref.id}` : endpoint;
    await request(ref.provider, closePath, 'PATCH', ref.provider === 'gitee' ? { repo: ref.repo, state: 'closed' } : { state: 'closed', state_reason: 'completed' });
    const closed = await readTrackerIssue(payload.ref, request);
    if (!['closed', '已关闭'].includes(closed.state)) throw new Error('Issue close not confirmed by readback');
  }
  await record(':completed', 'issue_sync_completed', { ref: payload.ref, status: payload.status, commentId, remoteState: 'closed' });
  return 'completed';
}

const nextAttempt = new Map<string, number>();
/** Retry reads and idempotent closes after outages; uncertain POSTs only reconcile existing comments. */
export async function drainIssueSync() {
  await drainIssueReopens();
  await enqueueIssueSync();
  const pending = await pendingIssueEvents('issue_sync_requested', ['issue_sync_completed', 'issue_sync_superseded']);
  for (const item of pending) {
    if (!item.nodeId || !item.node || !['passed', 'delivered_unverified'].includes(item.node.status) || (nextAttempt.get(item.id) || 0) > Date.now()) continue;
    nextAttempt.set(item.id, Date.now() + 30_000);
    try { if (await syncIssueDelivery(item.id) === 'completed') nextAttempt.delete(item.id); }
    catch (error) { console.error('[TaskGraph] Issue sync pending:', item.runId, item.nodeId, error instanceof Error ? error.message : String(error)); }
  }
}

/** Reclassification invalidates a remote close as well as local delivery receipts. */
export async function syncIssueReopen(eventId: string, request: TrackerRequest = trackerRequest) {
  const event = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: eventId } });
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${event.nodeId} FOR NO KEY UPDATE`;
    return syncCurrentIssueReopen(eventId, request);
  }, { timeout: 120_000 });
}
async function syncCurrentIssueReopen(eventId: string, request: TrackerRequest) {
  const event = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: eventId }, include: { node: true } });
  if (event.kind !== 'issue_reopen_requested' || !isRecord(event.payload) || typeof event.payload.ref !== 'string') throw new Error('Invalid Issue reopen request');
  const key = `issue:reopen:${event.id}`;
  if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: event.runId, idempotencyKey: key } } })) return;
  // A newly completed attempt has its own delivery receipt; an old reopen must not undo that close.
  if (event.node && !['passed', 'delivered_unverified'].includes(event.node.status)) {
    const ref = parseIssueRef(event.payload.ref);
    const current = await readTrackerIssue(event.payload.ref, request);
    if (!['open', 'progressing', '待办的', '进行中'].includes(current.state)) {
      await request(ref.provider, ref.provider === 'gitee' ? `/repos/${ref.owner}/issues/${ref.id}` : issueEndpoint(ref), 'PATCH',
        ref.provider === 'gitee' ? { repo: ref.repo, state: 'open' } : { state: 'open' });
      if (!['open', 'progressing', '待办的', '进行中'].includes((await readTrackerIssue(event.payload.ref, request)).state)) throw new Error('Issue reopen not confirmed');
    }
  }
  await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: event.runId, idempotencyKey: key } },
    create: { runId: event.runId, nodeId: event.nodeId, kind: 'issue_reopen_completed', idempotencyKey: key, payload: { requestId: event.id } }, update: {} });
}
async function drainIssueReopens() {
  const pending = await pendingIssueEvents('issue_reopen_requested', ['issue_reopen_completed']);
  for (const event of pending) {
    if ((nextAttempt.get(event.id) || 0) > Date.now()) continue;
    nextAttempt.set(event.id, Date.now() + 30_000);
    try { await syncIssueReopen(event.id); } catch { /* Existing ledger outbox retries without rerunning the agent. */ }
  }
}

async function pendingIssueEvents(kind: string, completedKinds: string[]) {
  const done = await prisma.taskGraphEvent.findMany({ where: { kind: { in: completedKinds } }, select: { payload: true, idempotencyKey: true } });
  const ids = done.flatMap(event => isRecord(event.payload) && typeof event.payload.requestId === 'string' ? [event.payload.requestId] : []);
  const legacyKeys = done.filter(event => event.idempotencyKey.endsWith(':completed')).map(event => event.idempotencyKey.replace(/:completed$/, ':requested'));
  return prisma.taskGraphEvent.findMany({ where: { kind, id: { notIn: ids }, idempotencyKey: { notIn: legacyKeys } }, include: { node: { select: { status: true } } }, orderBy: { createdAt: 'asc' }, take: 100 });
}
