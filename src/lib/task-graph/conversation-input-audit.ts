import { prisma } from '../prisma';
import { authorizedConversationInput, conversationInputsByIds, conversationReceiptKey } from './conversation-inbox';
import { observeWriterSnapshot } from './writer-snapshot';
import { observeExecutionWriter } from './phase-worker';
import { observeGraphWriter, parseGraphWriter } from './writer-ownership';

export type InputDisposition = 'completed' | 'assigned' | 'uncertain' | 'normal_delivery' | 'unresolved' | 'writer_not_exited' | 'eligible';

/** Audit never consumes input or interprets a failed/unknown delivery as an unprocessed message. */
export async function auditGraphConversationInputs(runId: string) {
  const events = await prisma.taskGraphEvent.findMany({ where: { runId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const rows: { inputId: string; sourceId?: string; roomMessageId?: string; disposition: InputDisposition; reason: string }[] = [];
  for (const event of events.filter(item => item.kind === 'conversation_input')) {
    const raw = event.payload as Record<string, unknown> | null;
    const row: (typeof rows)[number] = { inputId: event.id, disposition: 'unresolved', reason: 'Missing registered input identity' };
    rows.push(row);
    if (typeof raw?.executionId !== 'string') continue;
    const [input] = await conversationInputsByIds(prisma, runId, raw.executionId, [event.id]);
    row.sourceId = input.sourceId; row.roomMessageId = input.roomMessageId;
    const receipts = events.filter(item => {
      const payload = item.payload as Record<string, unknown> | null;
      return payload?.inputId === event.id;
    });
    if (receipts.some(item => item.kind === 'conversation_delivery_uncertain') || input.receivedState === 'delivery_uncertain' || input.rootInputId !== input.id) {
      row.disposition = 'uncertain'; row.reason = 'Prior delivery or recovery has uncertain effects; never replay'; continue;
    }
    if (receipts.some(item => item.kind === 'conversation_delivery_completed')) {
      row.disposition = 'completed'; row.reason = 'Recorded prior completion; never replay'; continue;
    }
    const bound = events.some(item => item.idempotencyKey === conversationReceiptKey(input.id));
    const steering = events.find(item => item.idempotencyKey === conversationReceiptKey(input.id) + ':steering');
    const steeringResult = events.find(item => item.idempotencyKey === conversationReceiptKey(input.id) + ':steering:result');
    if (bound || steering && (steeringResult?.payload as Record<string, unknown> | null)?.result !== 'rejected') {
      row.disposition = 'assigned'; row.reason = 'Binding or non-rejected steering exists; inspect original turn, never replay'; continue;
    }
    if (!input.roomMessageId || input.target?.kind === 'unresolved') { row.reason = 'No verifiable original room message or target'; continue; }
    const message = await prisma.liveRoomMessage.findUnique({ where: { id: input.roomMessageId }, include: { room: true, deliveries: true } });
    if (!message || message.content !== input.content || message.metadata !== input.sourceMetadata) { row.reason = 'Original message identity changed or absent'; continue; }
    if (message.deliveries.length) { row.disposition = 'normal_delivery'; row.reason = 'Existing ordinary delivery owns the original message'; continue; }
    const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: input.executionId }, include: { node: { include: { run: { include: { parentTask: true } }, executions: true } } } });
    if (job.node.runId !== runId || !job.childTaskId || message.room.sourceTaskId !== job.childTaskId ||
        !await authorizedConversationInput(input, job.childTaskId, job.node.run.parentTask.ownerUserId)) { row.reason = 'Original source authorization cannot be verified'; continue; }
    const reservations = events.filter(item => item.kind === 'conversation_followup_reserved' &&
      Array.isArray((item.payload as Record<string, unknown> | null)?.inputIds) &&
      ((item.payload as Record<string, unknown>).inputIds as unknown[]).includes(event.id));
    let exited = true;
    for (const reservation of reservations) {
      if (events.some(item => item.idempotencyKey === `conversation-followup:${reservation.id}:run`)) {
        row.disposition = 'assigned'; row.reason = 'Reservation has a bound run without a complete input receipt'; exited = false; break;
      }
      const writer = parseGraphWriter((reservation.payload as Record<string, unknown> | null)?.worker);
      if (!writer || (await observeGraphWriter(writer)).kind !== 'exited') { exited = false; break; }
    }
    if (!exited) { if (row.disposition !== 'assigned') { row.disposition = 'writer_not_exited'; row.reason = 'Reservation writer has no verified exit'; } continue; }
    const tasks = job.node.executions.flatMap(item => item.childTaskId ? [item.childTaskId] : []);
    tasks.push(`task-graph-review-${job.nodeId}`, `task-graph-architecture-${job.nodeId}`);
    const turns = await prisma.taskRun.findMany({ where: { taskId: { in: tasks } }, select: { id: true } });
    const proof = await observeWriterSnapshot({ jobs: job.node.executions, taskRunIds: turns.map(turn => turn.id), scope: 'execution', observeExecution: observeExecutionWriter });
    if (!proof.exited) { row.disposition = 'writer_not_exited'; row.reason = 'Task/workspace Writer has no verified exit'; continue; }
    row.disposition = 'eligible'; row.reason = 'Unconsumed authenticated original message; recheck under normal admission before queueing';
  }
  return rows;
}
