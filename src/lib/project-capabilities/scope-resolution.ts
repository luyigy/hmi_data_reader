import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { object, parseProjectCapabilityScope, restrictProjectCapabilities, type ProjectCapabilityPolicy } from './policy';

export type ScopeApproval = {
  id: string; runtimePinIds: string[];
} & ({ kind: 'legacy' } | { kind: 'change'; previousPolicyHash: string; originalClaim: string; candidateCommit: string; runtimeUpgradeRevision?: number });

/** The same approved scope is consumed by material access and runtime preparation. */
export async function resolveProjectScope(args: {
  runId: string; executionId: string; repository: string; snapshotHash: string;
  originalScope: unknown; policy: ProjectCapabilityPolicy;
}, db: Pick<Prisma.TransactionClient, 'taskGraphEvent'> = prisma) {
  const keys = [`project-scope-v2:${args.executionId}:${args.policy.hash}`, `project-scope:${args.executionId}:${args.policy.hash}`];
  for (const key of keys) {
    const event = await db.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: args.runId, idempotencyKey: key } } });
    if (!event) continue;
    const receipt = object(event.payload);
    if (event.kind !== 'project_capability_scope_approved' || receipt.executionId !== args.executionId || receipt.repository !== args.repository || receipt.snapshotHash !== args.snapshotHash) throw new Error('项目授权回执归属不一致');
    const scope = parseProjectCapabilityScope(receipt.scope);
    const policy = restrictProjectCapabilities(args.policy, scope);
    const runtimePinIds = receipt.runtimePinIds;
    if (!Array.isArray(runtimePinIds) || !runtimePinIds.every((id): id is string => typeof id === 'string')) throw new Error('项目授权回执缺少运行快照身份');
    if (key === keys[0]) {
      if (receipt.version !== 2 || typeof receipt.previousPolicyHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.previousPolicyHash) ||
          typeof receipt.originalClaim !== 'string' || !receipt.originalClaim || typeof receipt.candidateCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(receipt.candidateCommit)) throw new Error('项目授权变更回执无效');
      const revision = receipt.runtimeUpgradeRevision;
      if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new Error('运行工具升级回执版本无效');
      const approval: ScopeApproval = { kind: 'change', ...(typeof revision === 'number' ? { runtimeUpgradeRevision: revision } : {}), id: event.id, previousPolicyHash: receipt.previousPolicyHash, originalClaim: receipt.originalClaim, candidateCommit: receipt.candidateCommit, runtimePinIds };
      return { policy, approval };
    }
    // Legacy scope adoption never overrides an already approved scope.
    if (!args.originalScope) {
      const revision = receipt.runtimeUpgradeRevision;
      if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new Error('运行工具升级回执版本无效');
      const approval: ScopeApproval = { kind: 'legacy', id: event.id, runtimePinIds };
      return { policy, approval };
    }
  }
  if (!args.originalScope) throw new Error('现有任务尚无获批项目能力范围；先执行 project-capabilities:scope 只读预览，由平台批准范围，不能隐式扩大旧路线授权');
  return { policy: restrictProjectCapabilities(args.policy, args.originalScope), approval: null };
}
