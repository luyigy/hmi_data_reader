import assert from 'node:assert/strict';

async function main() {
  const projectConfig = await import('../src/lib/scheduled-jobs/project-config') as unknown as {
    loadProjectsConfig: () => Promise<unknown>;
  };
  projectConfig.loadProjectsConfig = async () => ({
    projects: [{
      id: 'project',
      feishu: { chat_id: 'chat', approver_open_ids: ['approver'] },
      jobs: [{ id: 'workflow', type: 'workflow_watcher', config: {} }],
    }],
  });

  let cursorJson: Record<string, unknown> = {
    commit: 'commit',
    pending: {
      key: 'pending',
      gate: 'plan_review',
      reviewState: 'review',
      reviewAttempt: 2,
      reviewMessageId: 'message-2',
      reviewExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  let updates = 0;
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    scheduledJobState: {
      findUnique: async () => ({ cursorJson }),
      update: async ({ data }: { data: { cursorJson: Record<string, unknown> } }) => {
        updates += 1;
        cursorJson = data.cursorJson;
      },
    },
  };
  let tail = Promise.resolve();
  const prismaModule = await import('../src/lib/prisma') as unknown as { prisma: Record<string, unknown> };
  prismaModule.prisma = {
    $transaction: <T>(callback: (value: typeof tx) => Promise<T>) => {
      const result = tail.then(() => callback(tx));
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const handlers = await import('../src/lib/scheduled-jobs/handlers') as unknown as {
    jobHandlers: Map<string, unknown>;
  };
  handlers.jobHandlers.delete('workflow_watcher');

  const { resolveWorkflowReviewCardAction } = await import(
    '../src/lib/scheduled-jobs/workflow-review'
  );
  const args = {
    projectId: 'project',
    jobId: 'workflow',
    pendingKey: 'pending',
    decision: 'approve' as const,
    actorOpenId: 'approver',
    messageId: 'message-2',
    reviewAttempt: 2,
  };
  const results = await Promise.all([
    resolveWorkflowReviewCardAction(args),
    resolveWorkflowReviewCardAction(args),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['applied', 'duplicate']);
  assert.equal(updates, 1);

  const stale = await resolveWorkflowReviewCardAction({ ...args, reviewAttempt: 1 });
  assert.equal(stale.status, 'stale');
  assert.equal(updates, 1);
}

void main();
