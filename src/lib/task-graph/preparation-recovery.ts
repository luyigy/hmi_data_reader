import { prisma } from '../prisma';
import { PreparationRejected, parsePreparationReceipt, preparationBindingTx, preparationHash, validatePreparationArtifacts, type PreparationReceipt } from './preparation-contract';
import { scheduleImplementationRecovery } from './implementation-result';
import { redactSensitiveText } from '../redact-sensitive';

export async function inspectPreparationBinding(runId: string, nodeKey: string, remediation: PreparationReceipt['remediation']) {
  return prisma.$transaction(tx => preparationBindingTx(tx, runId, nodeKey, remediation));
}

/** Local operator authority is the same OS/database capability required by task-graph:doctor. */
export async function registerPlatformPreparation(input: unknown) {
  const receipt = parsePreparationReceipt(input);
  return prisma.$transaction(async tx => {
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: receipt.runId, key: receipt.nodeKey } } });
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${node.id} FOR UPDATE`;
    const key = `preparation:${receipt.requestId}`;
    const previous = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: receipt.runId, idempotencyKey: key } } });
    if (previous) {
      if (preparationHash(previous.payload) !== preparationHash(receipt)) throw new Error('Preparation requestId reused with different payload');
      return { kind: 'already_registered', eventId: previous.id };
    }
    if (await preparationBindingTx(tx, receipt.runId, receipt.nodeKey, receipt.remediation) !== receipt.bindingHash) throw new Error('Stale preparation binding');
    await validatePreparationArtifacts(receipt.artifacts);
    const event = await tx.taskGraphEvent.create({ data: { runId: receipt.runId, nodeId: node.id,
      kind: 'platform_preparation_registered', idempotencyKey: key, payload: receipt } });
    return { kind: 'registered', eventId: event.id };
  });
}

export async function recoverPreparedImplementations(runId: string) {
  const events = await prisma.taskGraphEvent.findMany({ where: { runId, kind: 'platform_preparation_registered' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const event of events) {
    const key = `preparation-consumed:${event.id}`;
    if (await prisma.taskGraphEvent.count({ where: { runId, idempotencyKey: key } })) continue;
    let result: { kind: string; eventId?: string; reason?: string };
    try {
      const receipt = parsePreparationReceipt(event.payload);
      result = await scheduleImplementationRecovery(runId, receipt.nodeKey, `prepared:${event.id}`, event.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const controlledRejection = error instanceof PreparationRejected ||
        /^(实施仍在执行|原任务进程仍在执行|原执行者仍存活|待完成合并尚无|自动处理预算已耗尽|执行归属尚未核对|当前执行不是|缺少当前候选|没有可恢复|缺少原执行归属)/.test(reason) ||
        error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR'].includes(String(error.code));
      if (!controlledRejection) throw error;
      result = { kind: 'rejected', reason: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
    }
    await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } },
      create: { runId, nodeId: event.nodeId, kind: 'platform_preparation_consumed', idempotencyKey: key,
        payload: { preparationEventId: event.id, ...result } }, update: {} });
  }
}
