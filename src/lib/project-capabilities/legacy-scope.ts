import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { observeExecutionWriter } from '../task-graph/phase-worker';
import { executionProgress } from '../task-graph/execution-progress';
import { authorizeProjectCapabilities, object, projectCapabilityPolicy, parseProjectCapabilityScope } from './policy';

/** Host-operator migration only. Approval adds an auditable scope, never a new writer or retry budget. */
export async function migrateLegacyProjectScope(args: { executionId: string; expectedPolicyHash?: string; apply?: boolean; policyFile?: string; prepareRuntimeUpgrade?: boolean }) {
  const original = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: args.executionId }, include: { node: { include: { run: { include: { parentTask: true } } } } } });
  const policy = await projectCapabilityPolicy(original.repository, args.policyFile);
  if (!policy) throw new Error('项目未登记，先由平台管理员批准项目能力');
  const proposal = await prisma.taskGraphProposal.findUnique({ where: { parentTaskId_version: { parentTaskId: original.node.run.parentTaskId, version: original.node.run.version } } });
  const principal = proposal?.status === 'confirmed' && proposal.decidedBy ? `feishu:${policy.appId}:${proposal.decidedBy}`
    : original.node.run.parentTask.ownerUserId ? `platform:${original.node.run.parentTask.ownerUserId}` : '';
  authorizeProjectCapabilities(policy, [principal]);
  const progress = executionProgress(original.dispatchMetadata);
  const writer = original.claimToken ? await observeExecutionWriter(original) : { kind: 'exited' };
  const scope = parseProjectCapabilityScope({ policyHash: policy.hash, sources: policy.sources.map(source => source.key), readOnlyRoots: policy.readOnlyRoots });
  const pins = await prisma.taskGraphEvent.findMany({ where: { runId: original.node.runId, kind: 'runtime_snapshot_pinned', idempotencyKey: `runtime-snapshot:${original.id}:${original.claimToken}` } });
  const previousHashes = Array.from(new Set(pins.flatMap(pin => {
    const hash = object(object(pin.payload).snapshot).projectPolicyHash;
    return typeof hash === 'string' ? [hash] : [];
  })));
  if (previousHashes.length > 1) throw new Error('运行快照包含不一致的历史授权');
  const previousPolicyHash = previousHashes[0];
  const scopeChange = Boolean(previousPolicyHash && previousPolicyHash !== policy.hash);
  const incompatible = pins.some(pin => {
    const snapshot = object(object(pin.payload).snapshot), source = snapshot.source === null ? null : object(snapshot.source);
    return !isDeepStrictEqual(source ? source.declaration : null, policy.runtime || null) || !Array.isArray(snapshot.hostReadOnlyRoots) || snapshot.hostReadOnlyRoots.some(root => typeof root !== 'string' || !scope.readOnlyRoots.includes(root)) || scopeChange && !isDeepStrictEqual([...snapshot.hostReadOnlyRoots].sort(), [...scope.readOnlyRoots].sort());
  });
  const runtimeUpgradeAllowed = Boolean(args.prepareRuntimeUpgrade && writer.kind === 'exited' && incompatible && scopeChange && pins.length === 1 &&
    original.status === 'attention' && original.claimToken && progress?.phase === 'implement' && !progress.conflictRepair &&
    ['waiting_for_user', 'waiting_decision'].includes(progress.state) && original.node.status === 'attention' &&
    ['running', 'attention'].includes(original.node.run.status));
  const report = { executionId: original.id, node: original.node.key, project: policy.repository, policyHash: policy.hash, scope, writer,
    candidateCommit: progress?.candidateCommit || original.commit, claimToken: original.claimToken, incompatibleRuntimePin: incompatible, runtimeUpgradeAllowed, previousPolicyHash: previousPolicyHash || null, scopeChange,
    action: writer.kind !== 'exited' ? '保留现场，不能在写入者退出证明前迁移' : runtimeUpgradeAllowed ? '只追加下一 claim 的显式工具批准；旧 claim 不变，原入口预检并领取后才能使用' : incompatible ? '原工具快照与新批准配置不同，保留现场；需受控新执行固定工具，不能改写原快照' : '可以仅追加项目范围，不重启、不续跑、不改预算' };
  if (!args.apply) return { ...report, applied: false };
  if (args.expectedPolicyHash !== policy.hash) throw new Error('必须提供诊断输出中的完整 policyHash，防止批准过期配置');
  if (writer.kind !== 'exited' || incompatible && !runtimeUpgradeAllowed) throw new Error(report.action);
  if (scopeChange && (!original.claimToken || !report.candidateCommit)) throw new Error('授权变更缺少原执行身份或候选');
  const key = `${scopeChange ? 'project-scope-v2' : 'project-scope'}:${original.id}:${policy.hash}`;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
    const latest = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: original.id } });
    if (latest.updatedAt.getTime() !== original.updatedAt.getTime() || !isDeepStrictEqual(latest.dispatchMetadata, original.dispatchMetadata)) throw new Error('迁移期间执行归属或阶段改变');
    if (original.claimToken && (await observeExecutionWriter(latest)).kind !== 'exited') throw new Error('迁移前写入者退出证明已改变');
    const current = await projectCapabilityPolicy(original.repository, args.policyFile);
    if (current?.hash !== policy.hash) throw new Error('迁移期间项目配置改变');
    const prior = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: original.node.runId, idempotencyKey: key } } });
    if (scopeChange && prior) {
      const receipt = object(prior.payload);
      if (receipt.previousPolicyHash !== previousPolicyHash || receipt.originalClaim !== original.claimToken ||
          receipt.candidateCommit !== report.candidateCommit || (receipt.runtimeUpgradeRevision !== undefined) !== runtimeUpgradeAllowed || !isDeepStrictEqual(receipt.runtimePinIds, pins.map(pin => pin.id))) throw new Error('已有授权变更回执属于不同保存点，不能复用或覆盖');
    }
    await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: original.node.runId, idempotencyKey: key } }, update: {},
      create: { runId: original.node.runId, nodeId: original.nodeId, idempotencyKey: key, kind: 'project_capability_scope_approved',
        payload: { ...(runtimeUpgradeAllowed && progress ? { runtimeUpgradeRevision: progress.revision } : {}), ...(scopeChange ? { version: 2, previousPolicyHash } : {}), executionId: original.id, repository: original.repository, snapshotHash: original.node.run.snapshotHash, scope,
          principal, approvedBy: `host-operator:${process.getuid?.()}`, originalClaim: original.claimToken, candidateCommit: report.candidateCommit,
          approvalHash: createHash('sha256').update(JSON.stringify(report)).digest('hex'), runtimePinIds: pins.map(pin => pin.id) } } });
  });
  return { ...report, applied: true };
}
