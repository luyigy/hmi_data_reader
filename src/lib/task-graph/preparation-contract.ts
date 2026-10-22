import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { executionProgress } from './execution-progress';

export class PreparationRejected extends Error {
  constructor(message: string) { super(message); this.name = 'PreparationRejected'; Object.setPrototypeOf(this, new.target.prototype); }
}

export type PreparationArtifact = { path: string; sha256: string };
export type PreparationReceipt = {
  version: 1; runId: string; nodeKey: string; requestId: string;
  authorization: string; changeReason: string;
  readiness: 'local_operator_attested';
  remediation: 'upstream_binding' | 'missing_capability';
  bindingHash: string; artifacts: PreparationArtifact[];
};
export function preparationHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function parsePreparationReceipt(value: unknown): PreparationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreparationRejected('Invalid preparation receipt');
  const text = (key: string) => {
    const item: unknown = Reflect.get(value, key);
    if (typeof item !== 'string' || !item.trim()) throw new PreparationRejected(`Missing preparation ${key}`);
    return item;
  };
  const remediation = text('remediation');
  if (Reflect.get(value, 'version') !== 1 || Reflect.get(value, 'readiness') !== 'local_operator_attested' ||
      !['upstream_binding', 'missing_capability'].includes(remediation)) throw new PreparationRejected('Invalid preparation attestation');
  const requestId = text('requestId'), bindingHash = text('bindingHash');
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(bindingHash)) throw new PreparationRejected('Invalid preparation identity');
  const raw: unknown = Reflect.get(value, 'artifacts');
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new PreparationRejected('Preparation requires validation log artifacts');
  const artifacts = raw.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string' ||
        !('sha256' in item) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new PreparationRejected('Invalid preparation artifact');
    return { path: item.path, sha256: item.sha256 };
  });
  return { version: 1, runId: text('runId'), nodeKey: text('nodeKey'), requestId,
    authorization: text('authorization'), changeReason: text('changeReason'), readiness: 'local_operator_attested',
    remediation: remediation === 'upstream_binding' ? 'upstream_binding' : 'missing_capability', bindingHash, artifacts };
}
export async function validatePreparationArtifacts(artifacts: PreparationArtifact[]) {
  for (const artifact of artifacts) {
    if (resolve(artifact.path) !== artifact.path || await realpath(artifact.path) !== artifact.path) throw new PreparationRejected('Preparation artifact must be an absolute non-symlink path');
    const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new PreparationRejected('Preparation artifact must be a regular file at most 32 MiB');
      const bytes = await file.readFile(), after = await file.stat(), named = await stat(artifact.path);
      if (after.ino !== named.ino || after.dev !== named.dev) throw new PreparationRejected('Preparation artifact path was replaced');
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 || await realpath(artifact.path) !== artifact.path) throw new PreparationRejected('Preparation artifact changed or hash mismatch');
    } finally { await file.close(); }
  }
}
export async function preparationBindingTx(tx: Prisma.TransactionClient, runId: string, nodeKey: string, remediation: PreparationReceipt['remediation']) {
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { executions: true, run: true } });
  if (!['running', 'attention'].includes(node.run.status) || node.status !== 'attention') throw new PreparationRejected('Preparation requires a paused node in an active approved Run');
  if (node.executions.length !== 1) throw new PreparationRejected('Prepared recovery currently supports exactly one execution; multi-execution nodes require explicit scoped support');
  const job = node.executions[0], progress = executionProgress(job.dispatchMetadata);
  if (progress?.state === 'exhausted' || job.issueKind === 'retry_exhausted') throw new PreparationRejected('Preparation cannot reset exhausted execution');
  if (job.status !== 'attention' || !job.claimToken || !progress || progress.state !== 'waiting_decision' || progress.phase !== 'implement' ||
      !progress.candidateCommit || !progress.workspaceBase || progress.conflictRepair) throw new PreparationRejected('Preparation requires a versioned implement-phase waiting decision with candidate and original ownership');
  const failure = progress.lastFailure;
  if (!failure || (remediation === 'upstream_binding' ? failure.code !== 'missing_upstream_input' : failure.code !== 'environment_failed' || failure.blockerCause !== 'missing_capability') ||
      failure.requiresUserDecision === true || failure.owner !== undefined && failure.owner !== 'platform') throw new PreparationRejected('Preparation is not authorized for this business, permission, ownership or failure kind');
  const dependencies = await tx.taskGraphNode.findMany({ where: { runId, key: { in: node.dependsOn } }, include: { executions: true }, orderBy: { key: 'asc' } });
  if (dependencies.length !== node.dependsOn.length || dependencies.some(item => !['passed', 'delivered_unverified'].includes(item.status))) throw new PreparationRejected('Preparation dependencies have not passed');
  return preparationHash({ nodeId: node.id, snapshotHash: node.run.snapshotHash, executionId: job.id,
    claimToken: job.claimToken, taskRunId: job.taskRunId, baseCommit: job.baseCommit, candidateCommit: progress.candidateCommit,
    workspaceBase: progress.workspaceBase, revision: progress.revision, progress, worktreePath: job.worktreePath,
    worktreeBranch: job.worktreeBranch, dispatchMetadata: job.dispatchMetadata,
    dependencies: dependencies.map(item => ({ id: item.id, status: item.status, commits: item.executions.map(value => ({ id: value.id, commit: value.commit })).sort((a, b) => a.id.localeCompare(b.id)) })) });
}
export async function assertPreparationTx(tx: Prisma.TransactionClient, runId: string, nodeKey: string, eventId: string, validated: PreparationReceipt) {
  const event = await tx.taskGraphEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (event.kind !== 'platform_preparation_registered' || event.runId !== runId) throw new PreparationRejected('Invalid trusted preparation event');
  const receipt = parsePreparationReceipt(event.payload);
  const target = await tx.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, select: { id: true } });
  if (event.nodeId !== target.id) throw new PreparationRejected('Preparation event node mismatch');
  if (receipt.runId !== runId || receipt.nodeKey !== nodeKey ||
      event.idempotencyKey !== `preparation:${receipt.requestId}`) throw new PreparationRejected('Preparation target mismatch');
  if (await preparationBindingTx(tx, runId, nodeKey, receipt.remediation) !== receipt.bindingHash) throw new PreparationRejected('Stale preparation binding: revision, candidate, failure or dependencies changed');
  if (preparationHash(receipt) !== preparationHash(validated)) throw new PreparationRejected('Preparation receipt changed after artifact validation');
  return receipt;
}
