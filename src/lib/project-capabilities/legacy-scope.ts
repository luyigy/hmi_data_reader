import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { observeExecutionWriter } from '../task-graph/phase-worker';
import { executionProgress } from '../task-graph/execution-progress';
import { authorizeProjectCapabilities, object, projectCapabilityPolicy, parseProjectCapabilityScope } from './policy';

/** Host-operator migration only. Approval adds an auditable scope, never a new writer or retry budget. */
export async function migrateLegacyProjectScope(args: { executionId: string; expectedPolicyHash?: string; apply?: boolean; policyFile?: string }) {
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
  const incompatible = pins.some(pin => {
    const snapshot = object(object(pin.payload).snapshot), source = snapshot.source === null ? null : object(snapshot.source);
    return !isDeepStrictEqual(source ? source.declaration : null, policy.runtime || null) || !Array.isArray(snapshot.hostReadOnlyRoots) || snapshot.hostReadOnlyRoots.some(root => typeof root !== 'string' || !scope.readOnlyRoots.includes(root));
  });
  const report = { executionId: original.id, node: original.node.key, project: policy.repository, policyHash: policy.hash, scope, writer,
    candidateCommit: progress?.candidateCommit || original.commit, claimToken: original.claimToken, incompatibleRuntimePin: incompatible,
    action: writer.kind !== 'exited' ? '保留现场，不能在写入者退出证明前迁移' : incompatible ? '原工具快照与新批准配置不同，保留现场；需受控新执行固定工具，不能改写原快照' : '可以仅追加项目范围，不重启、不续跑、不改预算' };
  if (!args.apply) return { ...report, applied: false };
  if (args.expectedPolicyHash !== policy.hash) throw new Error('必须提供诊断输出中的完整 policyHash，防止批准过期配置');
  if (writer.kind !== 'exited' || incompatible) throw new Error(report.action);
  const key = `project-scope:${original.id}:${policy.hash}`;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${original.nodeId} FOR UPDATE`;
    const latest = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: original.id } });
    if (latest.updatedAt.getTime() !== original.updatedAt.getTime() || !isDeepStrictEqual(latest.dispatchMetadata, original.dispatchMetadata)) throw new Error('迁移期间执行归属或阶段改变');
    if (original.claimToken && (await observeExecutionWriter(latest)).kind !== 'exited') throw new Error('迁移前写入者退出证明已改变');
    const current = await projectCapabilityPolicy(original.repository, args.policyFile);
    if (current?.hash !== policy.hash) throw new Error('迁移期间项目配置改变');
    await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: original.node.runId, idempotencyKey: key } }, update: {},
      create: { runId: original.node.runId, nodeId: original.nodeId, idempotencyKey: key, kind: 'project_capability_scope_approved',
        payload: { executionId: original.id, repository: original.repository, snapshotHash: original.node.run.snapshotHash, scope,
          principal, approvedBy: `host-operator:${process.getuid?.()}`, originalClaim: original.claimToken, candidateCommit: report.candidateCommit,
          approvalHash: createHash('sha256').update(JSON.stringify(report)).digest('hex'), runtimePinIds: pins.map(pin => pin.id) } } });
  });
  return { ...report, applied: true };
}
