import { archiveValidationResults } from './validation-results';
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
  const recovery = await prisma.taskGraphEvent.findFirst({ where: { nodeId: node.id, kind: 'implementation_recovery_scheduled' }, orderBy: { createdAt: 'desc' } });
  const attempt = recovery ? `:${node.claimToken}` : '';
  const childIds = node.executions.flatMap((execution) => execution.childTaskId ? [execution.childTaskId] : []);
  const hasActiveRuns = () => prisma.taskRun.count({ where: { taskId: { in: [...childIds, ...node.executions.map((execution) => `task-graph-discussion-${execution.id}`), `task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] }, status: { in: ['running', 'pending'] } } });
  if (await hasActiveRuns()) return;
  for (const execution of node.executions) {
    if (!execution.commit || !execution.worktreePath || !execution.childTaskId) continue;
    const commit = execution.commit;
    const childTaskId = execution.childTaskId;
    const receipt = `execution:${execution.id}:workspace_cleaned${attempt}`;
    if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: receipt } } })) continue;
    const resultsDirectory = path.join(path.dirname(execution.repository), '.agent-platform-task-graph-results', hash(runId), hash(execution.id), execution.commit, ...(attempt ? [hash(attempt)] : []));
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
            kind: 'workspace_cleaned', payload: { executionId: execution.id, commit: execution.commit, attempt, worktreePath: execution.worktreePath, resultsDirectory: existsSync(resultsDirectory) ? resultsDirectory : null } } }),
          prisma.task.update({ where: { id: childTaskId }, data: { status: 'completed' } }),
        ]);
      });
    } catch (error) {
      const key = `execution:${execution.id}:workspace_cleanup_deferred${attempt}`;
      const detail = error instanceof Error ? error.message : String(error);
      await prisma.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id, idempotencyKey: key,
        kind: 'workspace_cleanup_deferred', payload: { detail } }], skipDuplicates: true });
    }
  }
  const receipts = await prisma.taskGraphEvent.count({ where: { runId, nodeId: node.id, kind: 'workspace_cleaned',
    ...(attempt ? { payload: { path: ['attempt'], equals: attempt } } : {}) } });
  if (receipts === node.executions.length && node.executions.length) {
    try {
      await withRepositoryLock(node.executions[0].repository, async () => {
        const key = `node:${nodeKey}:validation_workspace_cleaned:v1${attempt}`;
        if (await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey: key } } })) return;
        if (await hasActiveRuns()) return;
        const directory = path.join(path.dirname(node.executions[0].repository), '.agent-platform-task-graph-results', hash(runId), 'validation', hash(node.id), ...(attempt ? [hash(attempt)] : []));
        const archive = await archiveValidationResults(node.id, directory, async () => !await hasActiveRuns());
        await prisma.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: key,
          kind: 'validation_workspace_cleaned', payload: archive } });
        clearGraphHarnessRuntime(`task-graph-review-${node.id}`);
        clearGraphHarnessRuntime(`task-graph-architecture-${node.id}`);
        await prisma.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id,
          idempotencyKey: `node:${nodeKey}:workspaces_cleaned${attempt}`, kind: 'node_workspaces_cleaned', payload: {} }], skipDuplicates: true });
      });
    } catch (error) {
      await prisma.taskGraphEvent.createMany({ data: [{ runId, nodeId: node.id,
        idempotencyKey: `node:${nodeKey}:validation_cleanup_deferred:v1${attempt}`, kind: 'validation_workspace_cleanup_deferred',
        payload: { detail: error instanceof Error ? error.message : String(error) } }], skipDuplicates: true });
    }
  }
}

export async function cleanupFinishedWorkspaces() {
  // Completion receipts belong to one attempt; an old receipt must not hide a restored workspace.
  const nodes = await prisma.$queryRaw<{ runId: string; key: string }[]>`
    SELECT n."runId", n.key FROM "TaskGraphNode" n
    WHERE n.status IN ('passed', 'delivered_unverified')
      AND EXISTS (SELECT 1 FROM "TaskGraphExecution" x WHERE x."nodeId" = n.id
        AND x."childTaskId" IS NOT NULL AND x."worktreePath" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "TaskGraphEvent" e WHERE e."nodeId" = n.id
          AND e.kind IN ('validation_workspace_cleaned', 'validation_workspace_cleanup_deferred')
          AND e."idempotencyKey" = 'node:' || n.key ||
            CASE WHEN e.kind = 'validation_workspace_cleaned' THEN ':validation_workspace_cleaned:v1'
              ELSE ':validation_cleanup_deferred:v1' END ||
            CASE WHEN EXISTS (SELECT 1 FROM "TaskGraphEvent" r WHERE r."nodeId" = n.id
              AND r.kind = 'implementation_recovery_scheduled') THEN ':' || n."claimToken" ELSE '' END
      )
    ORDER BY n."updatedAt" ASC LIMIT 20`;

  for (const node of nodes) await cleanupCompletedNodeWorkspaces(node.runId, node.key);
}
