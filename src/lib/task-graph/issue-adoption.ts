import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { taskGraphSnapshotHash, type GraphDefinition } from './domain';
import { assertIssueSource, readIssueRoute, type IssueSource } from './issue-source';
import { trackerRequest, type TrackerRequest } from './issue-tracker';
import { graphGit } from './git-command';

export type ExistingRunRef = { runId: string; snapshotHash: string };
const scopeHash = (graph: GraphDefinition) => taskGraphSnapshotHash({ specRef: 'approved-scope', nodes: graph.nodes,
  ...(graph.defaultArchitectureReview ? { defaultArchitectureReview: graph.defaultArchitectureReview } : {}) });

export async function prepareExistingIssueAdoption(args: ExistingRunRef & { parentTaskId: string; parent: string; repositories?: string[] }, request: TrackerRequest = trackerRequest) {
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: args.runId } });
  if (run.parentTaskId !== args.parentTaskId || run.snapshotHash !== args.snapshotHash) throw new Error('原任务归属或获批版本不匹配');
  const { source } = await readIssueRoute(args.parent, args.repositories, request);
  const definition: GraphDefinition = { ...structuredClone(run.snapshot) as GraphDefinition, issueSource: source,
    adoptRun: { runId: run.id, snapshotHash: run.snapshotHash } };
  await assertExistingIssueAdoption(definition, request);
  return definition;
}

/** Association may add a tracker, never change the scope, roles, acceptance or Git baseline. */
export async function assertExistingIssueAdoption(definition: GraphDefinition, request: TrackerRequest = trackerRequest) {
  if (!definition.adoptRun || !definition.issueSource) throw new Error('现有运行关联缺少来源');
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: definition.adoptRun.runId }, include: { nodes: { include: { executions: true } } } });
  const original = run.snapshot as unknown as GraphDefinition;
  if (run.snapshotHash !== definition.adoptRun.snapshotHash || scopeHash(original) !== scopeHash(definition)) throw new Error('关联必须保持原获批目标、分工、模式与基线');
  const current = await assertIssueSource(definition.issueSource, request);
  if (!current || current.tickets.length !== original.nodes.length) throw new Error('Issue 与原 Slice 数量不匹配');
  const byRef = new Map(current.tickets.map((ticket) => [ticket.ref, ticket.key]));
  for (const node of original.nodes) {
    const ticket = current.tickets.find((ticket) => ticket.key === node.key);
    if (!ticket || !ticket.body.includes(node.goal) || node.executions.some((job) => !ticket.body.includes(job.instructions)) ||
      JSON.stringify([...node.dependsOn].sort()) !== JSON.stringify(ticket.blockedBy.map((ref) => byRef.get(ref)).sort())) throw new Error(`${node.key}: Issue 必须保留原获批范围与依赖`);
    const stored = run.nodes.find((stored) => stored.key === node.key);
    if (!stored || JSON.stringify([...stored.dependsOn].sort()) !== JSON.stringify([...node.dependsOn].sort())) throw new Error('原运行账本与快照不一致');
    for (const job of node.executions) {
      // A source checkout may have unrelated edits. Only immutable approved commits enter the run.
      await graphGit(job.repository, 'cat-file', '-e', `${job.baseCommit}^{commit}`);
      await graphGit(job.repository, 'merge-base', '--is-ancestor', job.baseCommit, job.gitRef);
      const execution = stored.executions.find((execution) => execution.key === job.key);
      if (!execution) throw new Error('原仓内任务缺失');
      if (execution.status === 'integrated') {
        if (!execution.commit || !execution.evidence) throw new Error('既有交付缺少提交或证据');
        await graphGit(job.repository, 'cat-file', '-e', `${execution.commit}^{commit}`);
      }
    }
  }
  const existing = await resolveRunIssueSource(run.id);
  if (existing && existing.hash !== definition.issueSource.hash) throw new Error('运行已关联另一份 Issue 来源，需要另行审查');
  return run;
}

/** One append-only association event activates Issue gates/sync; no execution or task is copied. */
export async function confirmExistingIssueAdoption(args: { definition: GraphDefinition; proposalId: string; actorId: string; parentTaskId: string }) {
  const run = await assertExistingIssueAdoption(args.definition);
  if (run.parentTaskId !== args.parentTaskId) throw new Error('关联不能跨父任务');
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TaskGraphRun" WHERE id = ${run.id} FOR UPDATE`;
    const current = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } });
    if (current.snapshotHash !== args.definition.adoptRun!.snapshotHash) throw new Error('原运行版本已变化');
    const key = { runId: run.id, idempotencyKey: 'issues:source:adopted' };
    const existing = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: key } });
    if (existing) {
      if ((existing.payload as { source: IssueSource }).source.hash !== args.definition.issueSource!.hash) throw new Error('已有不同来源关联');
      return;
    }
    await tx.taskGraphEvent.create({ data: { ...key, kind: 'issue_source_adopted', payload: {
      source: args.definition.issueSource as unknown as Prisma.InputJsonValue, originalSnapshotHash: run.snapshotHash,
      proposalId: args.proposalId, actorId: args.actorId,
    } } });
  });
  return run;
}

export async function resolveRunIssueSource(runId: string): Promise<IssueSource | undefined> {
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { snapshot: true, snapshotHash: true } });
  const graph = run.snapshot as unknown as GraphDefinition;
  if (graph.issueSource) return graph.issueSource;
  const event = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: 'issues:source:adopted' } } });
  if (!event) return;
  const binding = event.payload as { source: IssueSource; originalSnapshotHash: string };
  if (event.kind !== 'issue_source_adopted' || binding.originalSnapshotHash !== run.snapshotHash) throw new Error('Issue 关联与原运行版本不匹配');
  return binding.source;
}
