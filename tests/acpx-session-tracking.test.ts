import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { findLatestParticipantSession } from '../src/lib/acpx/session-tracking';
import type { AcpxPermissionConfig } from '../src/lib/acpx/types';

type Candidate = {
  id: string;
  role: string;
  status: string;
  harnessType: string;
  controlMetadata: string;
  taskRun: { status: string; updatedAt: Date };
};

type FindManyArgs = { where: Record<string, unknown> };

const interactiveParticipant = {
  continuationKey: 'live-room-member:kimi',
  executionBackend: 'platform_local',
  gatewayId: 'platform-local',
  harnessType: 'kimi-code',
  role: 'custom',
} as const;

const workspacePermission = (): AcpxPermissionConfig => ({
  profile: 'custom',
  sandboxMode: 'workspace-write',
  networkAccess: 'restricted',
  approvalPolicy: 'never',
  writableRoots: ['/repo'],
});

const makeCandidate = (overrides: Partial<Candidate> & { metadata?: Record<string, unknown> }): Candidate => {
  const { metadata, ...rest } = overrides;
  return {
    id: 'participant-1',
    role: 'feature:implement',
    status: 'completed',
    harnessType: 'kimi-code',
    controlMetadata: JSON.stringify({
      continuationKey: 'live-room-member:kimi',
      lastSessionId: 'ses_workflow',
      lastSessionKind: 'kimi_session',
      ...metadata,
    }),
    taskRun: { status: 'completed', updatedAt: new Date() },
    ...rest,
  };
};

const withMockedFindMany = async (
  handler: (args: FindManyArgs) => Candidate[],
  fn: (calls: FindManyArgs[]) => Promise<void>,
) => {
  const original = prisma.taskRunParticipant.findMany;
  const calls: FindManyArgs[] = [];
  prisma.taskRunParticipant.findMany = (async (args: FindManyArgs) => {
    calls.push(args);
    return handler(args);
  }) as unknown as typeof prisma.taskRunParticipant.findMany;
  try {
    await fn(calls);
  } finally {
    prisma.taskRunParticipant.findMany = original;
  }
};

void (async () => {
  // Same-role hit: fallback query is never issued.
  await withMockedFindMany(
    (args) => (args.where.role === 'custom'
      ? [makeCandidate({ id: 'same-role', role: 'custom', metadata: { lastSessionId: 'ses_custom' } })]
      : [makeCandidate({ id: 'workflow-role' })]),
    async (calls) => {
      const matched = await findLatestParticipantSession('task', interactiveParticipant, {
        allowRoleFallback: true,
      });
      assert.equal(matched?.participant.id, 'same-role');
      assert.equal(matched?.continuationSessionId, 'ses_custom');
      assert.equal(matched?.viaRoleFallback, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].where.role, 'custom');
    },
  );

  // Same-role miss: inherit the agent's latest completed workflow participant session.
  await withMockedFindMany(
    (args) => (args.where.role === 'custom' ? [] : [makeCandidate({ id: 'workflow-role' })]),
    async (calls) => {
      const matched = await findLatestParticipantSession('task', interactiveParticipant, {
        taskSessionId: 'session-1',
        allowRoleFallback: true,
      });
      assert.equal(matched?.participant.id, 'workflow-role');
      assert.equal(matched?.continuationSessionId, 'ses_workflow');
      assert.equal(matched?.continuationSessionKind, 'kimi_session');
      assert.equal(matched?.viaRoleFallback, true);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].where.role, undefined);
      assert.deepEqual(calls[1].where.taskRun, { taskId: 'task', taskSessionId: 'session-1' });
    },
  );

  // Fallback honors the stale / failed / non-completed / permission filters.
  const nonViable = [
    makeCandidate({ id: 'stale', metadata: { continuationStaleAt: new Date().toISOString() } }),
    makeCandidate({ id: 'running', status: 'running' }),
    makeCandidate({ id: 'failed-run', taskRun: { status: 'failed', updatedAt: new Date() } }),
    makeCandidate({
      id: 'permission-mismatch',
      metadata: {
        permissionConfig: { sandboxMode: 'danger-full-access', networkAccess: 'enabled', approvalPolicy: 'never' },
      },
    }),
    makeCandidate({ id: 'no-session', metadata: { lastSessionId: '', lastSessionKind: '' } }),
  ];
  await withMockedFindMany(
    (args) => (args.where.role === 'custom' ? [] : nonViable),
    async () => {
      const matched = await findLatestParticipantSession('task', interactiveParticipant, {
        permissionConfig: workspacePermission(),
        allowRoleFallback: true,
      });
      assert.equal(matched, null);
    },
  );

  // Permission-consistent fallback candidate is inherited.
  await withMockedFindMany(
    (args) => (args.where.role === 'custom'
      ? []
      : [makeCandidate({ id: 'permission-match', metadata: { permissionConfig: workspacePermission() } })]),
    async () => {
      const matched = await findLatestParticipantSession('task', interactiveParticipant, {
        permissionConfig: workspacePermission(),
        allowRoleFallback: true,
      });
      assert.equal(matched?.participant.id, 'permission-match');
      assert.equal(matched?.viaRoleFallback, true);
    },
  );

  // Fallback disabled (workflow-internal role serials): same-role miss stays a miss.
  await withMockedFindMany(
    (args) => (args.where.role === 'feature:review' ? [] : [makeCandidate({ id: 'workflow-role' })]),
    async (calls) => {
      const matched = await findLatestParticipantSession('task', {
        ...interactiveParticipant,
        role: 'feature:review',
      });
      assert.equal(matched, null);
      assert.equal(calls.length, 1);
    },
  );

  // Derived continuation keys embed the role, so cross-role fallback cannot match
  // participants without an explicit (role-independent) continuation key.
  await withMockedFindMany(
    (args) => (args.where.role
      ? []
      : [makeCandidate({
        id: 'derived-key',
        metadata: { continuationKey: 'platform_local:platform-local:kimi-code:feature:implement:default' },
      })]),
    async () => {
      const { continuationKey, ...derivedKeyParticipant } = interactiveParticipant;
      const matched = await findLatestParticipantSession('task', derivedKeyParticipant, {
        allowRoleFallback: true,
      });
      assert.equal(matched, null);
    },
  );

  console.log('acpx-session-tracking tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
