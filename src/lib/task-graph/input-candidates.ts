import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { realpath } from 'node:fs/promises';
import { prisma } from '../prisma';
import type { GraphDefinition } from './domain';
import { executionProgress } from './execution-progress';
import { graphGit } from './git-command';
import { parseInputManifest, type TaskInput } from './input-manifest';
import { isRecord } from './implementation-result';
import { observeExecutionWriter } from './phase-worker';
import { preparationHash, validatePreparationArtifacts, type PreparationArtifact } from './preparation-contract';
import { withRepositoryLock } from './repository-lock';
import { materializeUpstream } from './upstream-source';
import { observeWriterSnapshot, writerSnapshotMatches } from './writer-snapshot';

export type InputCandidateReceipt = {
  version: 1; executionId: string; requestId: string; claimToken: string; revision: number;
  inputHash: string; primaryCandidateCommit: string; repository: string; previousCommit: string;
  candidateCommit: string; authorization: string; artifacts: PreparationArtifact[];
};

function parseReceipt(value: unknown): InputCandidateReceipt {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('候选登记格式无效');
  const text = (key: string) => { const item = value[key]; if (typeof item !== 'string' || !item.trim()) throw new Error(`候选登记缺少 ${key}`); return item; };
  const receipt: InputCandidateReceipt = { version: 1, executionId: text('executionId'), requestId: text('requestId'), claimToken: text('claimToken'),
    revision: Number(value.revision), inputHash: text('inputHash'), primaryCandidateCommit: text('primaryCandidateCommit'), repository: text('repository'),
    previousCommit: text('previousCommit'), candidateCommit: text('candidateCommit'), authorization: text('authorization'), artifacts: [] };
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(receipt.requestId) || !/^[a-f0-9]{64}$/.test(receipt.inputHash) ||
      [receipt.primaryCandidateCommit, receipt.previousCommit, receipt.candidateCommit].some(commit => !/^[a-f0-9]{40,64}$/.test(commit)) ||
      receipt.previousCommit === receipt.candidateCommit || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 20) throw new Error('候选版本、摘要或证据无效');
  receipt.artifacts = value.artifacts.map(item => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('候选证据无效');
    return { path: item.path, sha256: item.sha256 };
  });
  return receipt;
}

function parseCandidate(payload: unknown) {
  if (!isRecord(payload) || typeof payload.sourcePath !== 'string') throw new Error('已登记候选无效');
  if (!Array.isArray(payload.integrationRefs) || !payload.integrationRefs.length || !payload.integrationRefs.every(ref => typeof ref === 'string' && ref.trim())) throw new Error('候选缺少批准的汇合分支');
  return { receipt: parseReceipt(payload.receipt), sourcePath: payload.sourcePath, integrationRefs: payload.integrationRefs as string[] };
}

/** Trusted local operator entry, like registerPlatformPreparation. No dispatch or approval is inferred from a directory grant. */
export async function registerInputCandidate(value: unknown) {
  const receipt = parseReceipt(value);
  const { node: observedNode, ...job } = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: receipt.executionId }, include: { node: { include: { run: true } } } });
  const key = `input-candidate:${job.id}:${receipt.requestId}`;
  const previous = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: observedNode.runId, idempotencyKey: key } } });
  const replay = (event: NonNullable<typeof previous>) => {
    if (preparationHash(parseCandidate(event.payload).receipt) !== preparationHash(receipt)) throw new Error('候选 requestId 已用于不同登记');
    return { eventId: event.id, kind: 'already_registered' as const };
  };
  if (previous) return replay(previous);
  const progress = executionProgress(job.dispatchMetadata);
  if (!['running', 'attention'].includes(observedNode.run.status) || observedNode.status !== 'attention' || job.status !== 'attention' ||
      !job.childTaskId || !progress || progress.phase !== 'implement' || !['waiting_for_user', 'waiting_decision'].includes(progress.state) ||
      progress.conflictRepair || job.claimToken !== receipt.claimToken || progress.revision !== receipt.revision ||
      progress.candidateCommit !== receipt.primaryCandidateCommit) throw new Error('候选登记的执行版本已改变或仍在执行');
  const pin = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: {
    runId: observedNode.runId, idempotencyKey: `execution:${job.id}:inputs:${job.claimToken}` } } });
  const manifest = parseInputManifest(pin.payload);
  const input = manifest.inputs.find(item => item.repository === receipt.repository);
  if (manifest.executionId !== job.id || manifest.hash !== receipt.inputHash || !input || input.commit !== receipt.previousCommit ||
      await realpath(receipt.repository) !== receipt.repository) throw new Error('候选登记与原固定输入不一致');
  const definition = observedNode.run.snapshot as unknown as GraphDefinition;
  const integrationRefs = input.replacement
    ? parseCandidate((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: input.replacement.eventId } })).payload).integrationRefs
    : Array.from(new Set(definition.nodes.flatMap(node => node.executions.filter(item => input.executions.includes(`${node.key}/${item.key}`)).map(item => item.gitRef))));
  if (!integrationRefs.length) throw new Error('候选没有已批准的汇合分支');
  await validatePreparationArtifacts(receipt.artifacts);
  const proof = await observeWriterSnapshot({ jobs: [job], scope: 'execution', observeExecution: observeExecutionWriter });
  if (!proof.exited) throw new Error('原写作者仍存活或无法确认退出');
  const sourcePath = await withRepositoryLock(receipt.repository, async () => {
    await graphGit(receipt.repository, 'merge-base', '--is-ancestor', receipt.previousCommit, receipt.candidateCommit);
    return materializeUpstream(receipt.repository, receipt.candidateCommit);
  });
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
    const existing = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: observedNode.runId, idempotencyKey: key } } });
    if (existing) return replay(existing);
    const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId }, include: { run: true } });
    if (node.status !== 'attention' || !['running', 'attention'].includes(node.run.status) || node.run.snapshotHash !== observedNode.run.snapshotHash ||
        !await writerSnapshotMatches(tx, proof)) throw new Error('候选登记期间执行身份改变');
    if (await tx.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'task_input_candidate_registered', AND: [
      { payload: { path: ['receipt', 'executionId'], equals: job.id } }, { payload: { path: ['receipt', 'claimToken'], equals: receipt.claimToken } },
      { payload: { path: ['receipt', 'repository'], equals: receipt.repository } } ] } })) throw new Error('该输入已有待应用候选，不能覆盖');
    const event = await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id, kind: 'task_input_candidate_registered',
      idempotencyKey: key, payload: { receipt, sourcePath, integrationRefs } } });
    return { eventId: event.id, kind: 'registered' as const };
  });
}

export async function replacementInputs(job: TaskGraphExecution, inputs: TaskInput[]) {
  const events = await prisma.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: 'task_input_candidate_registered',
    payload: { path: ['receipt', 'executionId'], equals: job.id } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const result = inputs.map(input => ({ ...input }));
  const bindings: { eventId: string; primaryCandidateCommit: string }[] = [];
  for (const event of events) {
    const { receipt, sourcePath } = parseCandidate(event.payload);
    if (receipt.claimToken === job.claimToken) continue;
    const index = result.findIndex(input => input.repository === receipt.repository);
    if (index === -1 || result[index].commit !== receipt.previousCommit) throw new Error('补充候选的前置基线改变，需要重新核对输入');
    result[index] = { ...result[index], commit: receipt.candidateCommit, sourcePath, executions: [], resultsDirectories: [],
      quality: ['candidate_unverified'], replacement: { eventId: event.id, previousCommit: receipt.previousCommit } };
    bindings.push({ eventId: event.id, primaryCandidateCommit: receipt.primaryCandidateCommit });
  }
  return { inputs: result, bindings };
}

export async function recordCandidateInputs(tx: Prisma.TransactionClient, job: TaskGraphExecution, bindings: Awaited<ReturnType<typeof replacementInputs>>['bindings']) {
  if (!bindings.length) return;
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } });
  for (const binding of bindings) {
    const key = `input-candidate-applied:${binding.eventId}`;
    if (await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: key } } })) continue;
    if (executionProgress(job.dispatchMetadata)?.candidateCommit !== binding.primaryCandidateCommit) throw new Error('主仓候选已改变，补充输入尚未应用');
    await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id, kind: 'task_input_candidate_applied', idempotencyKey: key,
      payload: { executionId: job.id, claimToken: job.claimToken, candidateEventId: binding.eventId } } });
  }
}
