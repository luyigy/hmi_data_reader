import { clearGraphHarnessRuntime } from './harness-runtime';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { prisma } from '../prisma';
import { cleanupIntegratedJobWorktree } from './worktree';
import { withRepositoryLock } from './repository-lock';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Failed and active nodes retain their workspace. Completed nodes preserve outputs then release it. */
export async function cleanupCompletedNodeWorkspaces(runId: string, nodeKey: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { executions: true } });
  if (!['passed', 'delivered_unverified'].includes(node.status)) return;
  const childIds = node.executions.flatMap((execution) => execution.childTaskId ? [execution.childTaskId] : []);
  const active = await prisma.taskRun.count({ where: { taskId: { in: [...childIds, ...node.executions.map((execution) => `task-graph-discussion-${execution.id}`), `task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] }, status: { in: ['running', 'pending'] } } });
  if (active) return;
  for (const execution of node.executions) {
    if (!execution.commit || !execution.worktreePath || !execution.childTaskId) continue;
    const commit = execution.commit;
    const childTaskId = execution.childTaskId;
    const receipt = `execution:${execution.id}:workspace_cleaned`;
    if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: receipt } } })) continue;
    const resultsDirectory = path.join(path.dirname(execution.repository), '.agent-platform-task-graph-results', hash(runId), hash(execution.id), execution.commit);
    try {
      await withRepositoryLock(execution.repository, async () => {
        if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: receipt } } })) return;
        await cleanupIntegratedJobWorktree({
          repoPath: execution.repository, runId, jobId: execution.id,
          integrationRef: `refs/heads/task-graph/integration/${hash(runId)}`,
          expectedCommit: commit, resultsDirectory,
        });
        clearGraphHarnessRuntime(childTaskId);
        clearGraphHarnessRuntime(`task-graph-discussion-${execution.id}`);
        await prisma.$transaction([
          prisma.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: receipt,
            kind: 'workspace_cleaned', payload: { executionId: execution.id, commit: execution.commit, worktreePath: execution.worktreePath, resultsDirectory: existsSync(resultsDirectory) ? resultsDirectory : null } } }),
          prisma.task.update({ where: { id: childTaskId }, data: { status: 'completed' } }),
        ]);
      });
    } catch (error) {
      const key = `execution:${execution.id}:workspace_cleanup_deferred`;
      const detail = error instanceof Error ? error.message : String(error);
      await prisma.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id, idempotencyKey: key,
        kind: 'workspace_cleanup_deferred', payload: { detail } }], skipDuplicates: true });
    }
  }
  const receipts = await prisma.taskGraphEvent.count({ where: { runId, nodeId: node.id, kind: 'workspace_cleaned' } });
  if (receipts === node.executions.length) {
    clearGraphHarnessRuntime(`task-graph-review-${node.id}`);
    clearGraphHarnessRuntime(`task-graph-architecture-${node.id}`);
    await prisma.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id,
      idempotencyKey: `node:${nodeKey}:workspaces_cleaned`, kind: 'node_workspaces_cleaned', payload: {} }], skipDuplicates: true });
  }
}

export async function cleanupFinishedWorkspaces() {
  const nodes = await prisma.taskGraphNode.findMany({
    where: { status: { in: ['passed', 'delivered_unverified'] },
      executions: { some: { childTaskId: { not: null }, worktreePath: { not: null } } },
      events: { none: { kind: { in: ['node_workspaces_cleaned', 'workspace_cleanup_deferred'] } } } },
    orderBy: { updatedAt: 'asc' }, take: 20, select: { runId: true, key: true },
  });
  for (const node of nodes) await cleanupCompletedNodeWorkspaces(node.runId, node.key);
}
