import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { readProcessIdentity } from './task-graph/process-lineage';
import { prisma } from './prisma';
import { resolveFeishuMessageTarget, sendFeishuInteractiveMessage } from './feishu-api';
import { updateFeishuTaskEntryCard } from './feishu-task-entry-api';
import { safeFeishuCard } from './feishu-card-markdown';
import { agentReplyElements, turnReplyElements } from './agent-reply-card';
import { graphNodeForTask } from './task-graph/task-binding';

export type TurnCardIdentity = { sourceMessageId: string; memberId: string; bindingId: string };
const key = (identity: TurnCardIdentity) => createHash('sha256').update(JSON.stringify([identity.sourceMessageId, identity.memberId, identity.bindingId])).digest('hex').slice(0, 48);

async function currentOwner() {
  const identity = await readProcessIdentity(process.pid);
  return JSON.stringify({ pid: process.pid, startTime: identity.startTime, hostname: os.hostname(),
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() });
}

export async function prepareRoomTurnCard(sourceMessageId: string, memberId: string) {
  const source = await prisma.liveRoomMessage.findUniqueOrThrow({ where: { id: sourceMessageId }, include: { room: true } });
  if (await graphNodeForTask(source.room.sourceTaskId)) return null;
  const metadata = JSON.parse(source.metadata || '{}');
  const bindings = await prisma.feishuConversationBinding.findMany({ where: { liveRoomId: source.roomId } });
  const binding = bindings.find(row => row.id === metadata.feishuBindingId) || bindings.find(row => row.chatId === metadata.feishuChatId) || (bindings.length === 1 ? bindings[0] : undefined);
  if (!binding) return null;
  const identity = { sourceMessageId, memberId, bindingId: binding.id };
  const row = await reserveTurnCard(identity);
  if (!row.cardJson) {
    const member = await prisma.liveRoomMember.findUniqueOrThrow({ where: { id: memberId } });
    await publishTurnCard(identity, { config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: `${member.displayName} · 等待执行` } },
      elements: turnReplyElements({ active: true, latest: '已收到消息，等待执行。', final: '', process: '', tools: '', footnotes: ['运行信息尚未提供'] }),
    }, false, true).catch(error => console.error('[TurnCard] placeholder queued:', error));
  }
  return { identity, binding };
}

export async function reserveTurnCard(identity: TurnCardIdentity) {
  const [source, member, binding] = await Promise.all([
    prisma.liveRoomMessage.findUniqueOrThrow({ where: { id: identity.sourceMessageId }, include: { room: { select: { sourceTaskId: true } } } }),
    prisma.liveRoomMember.findUniqueOrThrow({ where: { id: identity.memberId } }),
    prisma.feishuConversationBinding.findUniqueOrThrow({ where: { id: identity.bindingId } }),
  ]);
  if (source.roomId !== member.roomId || source.roomId !== binding.liveRoomId) throw new Error('Reply card recipient or topic changed');
  if (await graphNodeForTask(source.room.sourceTaskId)) throw new Error('Graph-bound replies belong to the graph conversation');
  const ownerJson = await currentOwner();
  return prisma.feishuTurnCard.upsert({ where: { id: key(identity) }, create: { id: key(identity), ...identity,
    targetJson: JSON.stringify(resolveFeishuMessageTarget(binding)), ownerJson, createdAt: source.createdAt }, update: {} });
}

export async function bindTurnCardRun(identity: TurnCardIdentity, taskRunId: string) {
  await prisma.feishuTurnCard.updateMany({ where: { id: key(identity), terminal: false }, data: { taskRunId, ownerJson: await currentOwner() } });
}

export async function publishTurnCard(identity: TurnCardIdentity, card: Record<string, unknown>, terminal: boolean, onlyIfEmpty = false) {
  const id = key(identity);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "FeishuTurnCard" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.feishuTurnCard.findUniqueOrThrow({ where: { id } });
    if (row.terminal || onlyIfEmpty && row.cardJson) return;
    await tx.feishuTurnCard.update({ where: { id }, data: { cardJson: JSON.stringify(safeFeishuCard(card)), terminal,
      revision: { increment: 1 }, pending: true } });
  });
  return deliverTurnCard(id);
}

async function deliverTurnCard(id: string): Promise<string> {
  // Persist the send intent before the HTTP request, so an uncertain response reuses its UUID.
  await prisma.feishuTurnCard.updateMany({ where: { id, sendStartedAt: null }, data: { sendStartedAt: new Date() } });
  return prisma.$transaction(async tx => {
    const target = await tx.feishuTurnCard.findUniqueOrThrow({ where: { id } });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`turn-card:${target.bindingId}`}, 0))`;
    await tx.$queryRaw`SELECT id FROM "FeishuTurnCard" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.feishuTurnCard.findUniqueOrThrow({ where: { id } });
    if (!row.pending && row.messageId) return row.messageId;
    if (!row.cardJson) throw new Error('Reply card has no prepared content');
    const binding = await tx.feishuConversationBinding.findUniqueOrThrow({ where: { id: row.bindingId } });
    const source = await tx.liveRoomMessage.findUniqueOrThrow({ where: { id: row.sourceMessageId } });
    if (binding.liveRoomId !== source.roomId) throw new Error('Reply card topic changed');
    if (JSON.stringify(resolveFeishuMessageTarget(binding)) !== row.targetJson) throw new Error('Reply card target changed; keep the original receipt');
    const card: Record<string, unknown> = JSON.parse(row.cardJson);
    let messageId = row.messageId;
    if (messageId) await updateFeishuTaskEntryCard(messageId, card);
    else {
      if (!row.sendStartedAt || Date.now() - row.sendStartedAt.getTime() > 45 * 60_000) throw new Error('Reply receipt uncertain; reconcile original send before retrying');
      messageId = await sendFeishuInteractiveMessage({ ...resolveFeishuMessageTarget(binding), card, uuid: id }) || null;
      if (!messageId) throw new Error('Reply card send returned no receipt');
    }
    await tx.feishuTurnCard.update({ where: { id }, data: { messageId, pending: false, deliveredRevision: row.revision } });
    return messageId;
  }, { timeout: 25000 });
}

async function finishSavedCard(identity: TurnCardIdentity, text: string, success: boolean, footnotes: string[] = []) {
  const row = await prisma.feishuTurnCard.findUniqueOrThrow({ where: { id: key(identity) } });
  if (row.terminal) return;
  const card = JSON.parse(row.cardJson || '{}');
  const member = await prisma.liveRoomMember.findUniqueOrThrow({ where: { id: row.memberId } });
  const elements: Record<string, unknown>[] = card.body?.elements || card.elements || [];
  const body = agentReplyElements({ text })[0];
  const rest = elements.filter(element => element.tag !== 'markdown' && (!footnotes.length || element.tag !== 'note'));
  await publishTurnCard(identity, {
    config: { wide_screen_mode: true },
    header: { template: success ? 'green' : 'red', title: { tag: 'plain_text', content: `${member.displayName} · ${success ? '执行完成' : '执行失败'}` } },
    elements: [body, ...rest, ...(footnotes.length ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: footnotes.join('\n') }] }] : [])],
  }, true);
}

export async function failRoomTurnCard(sourceMessageId: string, memberId: string, error: string) {
  const rows = await prisma.feishuTurnCard.findMany({ where: { sourceMessageId, memberId } });
  for (const row of rows) await finishSavedCard(row, error, false).catch(error => console.error('[TurnCard] failure delivery queued:', error));
  return rows.length > 0;
}

/** The assistant message remains in the room ledger; its text already belongs to this card. */
export async function finishOwnedTurnCard(identity: TurnCardIdentity, final?: { text: string; footnotes: string[] }) {
  const row = await prisma.feishuTurnCard.findUnique({ where: { id: key(identity) } });
  if (!row) return false;
  if (!row.terminal) {
    if (!final) throw new Error('Reply card has not saved its final answer');
    await finishSavedCard(identity, final.text, true, final.footnotes);
  }
  await deliverTurnCard(row.id).catch(error => console.error('[TurnCard] final delivery queued:', error));
  return true;
}

export async function relayPendingTurnCards() {
  const interrupted = await prisma.feishuTurnCard.findMany({ where: { terminal: false }, orderBy: { createdAt: 'asc' } });
  for (const row of interrupted) {
    try {
      if (!row.taskRunId) {
        const delivery = await prisma.liveRoomDelivery.findFirst({ where: { roomMessageId: row.sourceMessageId, targetMemberId: row.memberId }, orderBy: { createdAt: 'desc' } });
        if (delivery && ['failed', 'superseded', 'fallback'].includes(delivery.deliveryStatus)) {
          await finishSavedCard(row, delivery.fallbackReason || '本轮未能启动，请查看任务运行记录。', false);
        }
        continue;
      }
      const owner = JSON.parse(row.ownerJson);
      if (owner.hostname !== os.hostname()) continue;
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const alive = owner.bootId === bootId && await readProcessIdentity(owner.pid).then(p => p.startTime === owner.startTime && !['Z', 'X'].includes(p.state), error => {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
        throw error;
      });
      if (alive) continue;
      const run = await prisma.taskRun.findUnique({ where: { id: row.taskRunId! }, include: { participants: true } });
      if (!run || !['completed', 'failed', 'stopped', 'interrupted'].includes(run.status)) continue;
      const { buildRunReplyCard } = await import('./task-run-reply-card');
      const events = await prisma.taskRunEvent.findMany({ where: { taskRunId: run.id }, orderBy: { sequence: 'asc' } });
      const card = buildRunReplyCard(run, events.filter(event => !['stdout_chunk', 'stderr_chunk', 'summary'].includes(event.eventType)), [], events.filter(event => event.eventType === 'stdout_chunk'));
      const member = await prisma.liveRoomMember.findUniqueOrThrow({ where: { id: row.memberId } });
      card.header.title.content = `${member.displayName} · ${run.status === 'completed' ? '执行完成' : '执行已停止'}`;
      await publishTurnCard(row, card, true);
    } catch (error) { console.error('[TurnCard] interrupted finalization:', { id: row.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const rows = await prisma.feishuTurnCard.findMany({ where: { pending: true, cardJson: { not: null } }, orderBy: { createdAt: 'asc' }, take: 50 });
  for (const row of rows) {
    try { await deliverTurnCard(row.id); }
    catch (error) { console.error('[TurnCard] pending delivery:', { id: row.id, error: error instanceof Error ? error.message : String(error) }); }
  }
}
