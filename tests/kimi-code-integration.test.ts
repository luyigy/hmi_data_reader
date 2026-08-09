import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { listHarnessAdapters } from '../src/lib/harness';
import {
  findLatestParticipantSession,
  getContinuationSession,
} from '../src/lib/acpx/session-tracking';
import {
  parseTaskRoomSessionResetMarker,
  sliceTaskRoomMessagesForParticipant,
} from '../src/lib/task-room';

const requireModule = createRequire(__filename);

void (async () => {
  assert.match(
    await readFile('src/lib/acpx/runner-harness.ts', 'utf8'),
    /const DEFAULT_LOCAL_HARNESS_MAX_RUNTIME_MS = 24 \* 60 \* 60 \* 1000;/,
  );
  assert.match(
    await readFile('src/lib/acpx/runner-harness.ts', 'utf8'),
    /workspaceRoot && !\[[^\]]*'pi-agent'[^\]]*\]\.includes\(participant\.harnessType\)/,
  );
  assert.deepEqual(
    listHarnessAdapters().map((adapter) => adapter.type).sort(),
    [
      'antigravity',
      'claude',
      'claude-haha',
      'codex',
      'deepseek',
      'gemini-cli',
      'kimi-code',
      'pi-agent',
    ],
  );

  assert.deepEqual(
    getContinuationSession({
      harnessType: 'kimi-code',
      controlMetadata: '{"lastSessionId":"ses_kimi","lastSessionKind":"kimi_session"}',
    }),
    { sessionId: 'ses_kimi', sessionKind: 'kimi_session' },
  );
  assert.deepEqual(
    [
      ['codex', '{"codexThreadId":"thread_codex"}'],
      ['claude', '{"claudeSessionId":"session_claude"}'],
      ['deepseek', '{"deepseekThreadId":"thread_deepseek"}'],
      ['gemini-cli', '{"geminiSessionId":"session_gemini"}'],
      ['pi-agent', '{"piSessionDir":"session_pi"}'],
    ].map(([harnessType, controlMetadata]) =>
      getContinuationSession({ harnessType, controlMetadata }).sessionId),
    ['thread_codex', 'session_claude', 'thread_deepseek', 'session_gemini', 'session_pi'],
  );
  assert.deepEqual(
    getContinuationSession({ harnessType: 'antigravity', controlMetadata: '{}' }),
    { sessionId: null, sessionKind: null },
  );

  const originalParticipantFindMany = prisma.taskRunParticipant.findMany;
  let continuationWhere: unknown;
  prisma.taskRunParticipant.findMany = (async ({ where }: { where: unknown }) => {
    continuationWhere = where;
    return [];
  }) as unknown as typeof prisma.taskRunParticipant.findMany;
  try {
    assert.equal(await findLatestParticipantSession(
      'task',
      {
        continuationKey: 'live-room-member:kimi',
        executionBackend: 'platform_local',
        gatewayId: 'platform-local',
        harnessType: 'kimi-code',
        role: 'custom',
      },
      { taskSessionId: 'fresh-task-session' },
    ), null);
    assert.deepEqual(continuationWhere, {
      taskRun: { taskId: 'task', taskSessionId: 'fresh-task-session' },
      executionBackend: 'platform_local',
      gatewayId: 'platform-local',
      harnessType: 'kimi-code',
      role: 'custom',
      agentId: null,
    });
  } finally {
    prisma.taskRunParticipant.findMany = originalParticipantFindMany;
  }

  const resetContent = 'TASK_ROOM_SESSION_RESET:fresh-task-session:new-session:kimi-member';
  assert.deepEqual(parseTaskRoomSessionResetMarker(resetContent), {
    sessionId: 'fresh-task-session',
    reason: 'new-session:kimi-member',
    memberId: 'kimi-member',
  });
  const messages = [
    {
      userId: 'user',
      userName: '用户',
      content: 'old turn',
      createdAt: new Date(0),
    },
    {
      userId: 'system',
      userName: '系统',
      content: resetContent,
      createdAt: new Date(1),
    },
    {
      userId: 'user',
      userName: '用户',
      content: 'fresh turn',
      createdAt: new Date(2),
    },
  ];
  assert.deepEqual(
    sliceTaskRoomMessagesForParticipant(
      messages,
      'platform_local:platform-local:kimi-code:custom:default',
      'kimi-member',
    ).map((message) => message.content),
    ['fresh turn'],
  );

  const realAgentsModule = requireModule('../src/lib/real-agents') as {
    getRealAgentsStatus: typeof import('../src/lib/real-agents').getRealAgentsStatus;
  };
  const platformLocalModule = requireModule('../src/lib/platform-local-init') as typeof import('../src/lib/platform-local-init');
  const originalGetRealAgentsStatus = realAgentsModule.getRealAgentsStatus;
  const originalEnsurePlatformLocalAgents = platformLocalModule.ensurePlatformLocalAgents;
  const originalGetServerHostname = platformLocalModule.getServerHostname;
  const originalGatewayFindMany = prisma.gateway.findMany;
  const originalRemoteHostFindMany = prisma.remoteHarnessHost.findMany;
  const originalAgentFindMany = prisma.agent.findMany;
  const harnessTypes = [
    'antigravity',
    'claude',
    'claude-haha',
    'codex',
    'deepseek',
    'gemini-cli',
    'kimi-code',
    'pi-agent',
  ];

  realAgentsModule.getRealAgentsStatus = (async () => Object.fromEntries(
    harnessTypes.map((type) => [type, {
      available: true,
      version: type === 'kimi-code' ? '0.29.2' : 'existing',
    }]),
  )) as typeof realAgentsModule.getRealAgentsStatus;
  platformLocalModule.ensurePlatformLocalAgents =
    (async () => []) as typeof platformLocalModule.ensurePlatformLocalAgents;
  platformLocalModule.getServerHostname = () => 'test-host';
  prisma.gateway.findMany =
    (async () => []) as unknown as typeof prisma.gateway.findMany;
  prisma.remoteHarnessHost.findMany =
    (async () => []) as unknown as typeof prisma.remoteHarnessHost.findMany;
  prisma.agent.findMany = (async () => harnessTypes.map((type) => ({
    id: `platform-local:test-host:${type}`,
    name: type,
    type,
    hostname: 'test-host',
    userNickname: null,
    status: 'online',
  }))) as unknown as typeof prisma.agent.findMany;

  try {
    const { deriveGatewayHarnessOptions } = await import('../src/lib/acpx/catalog');
    const {
      listLiveRoomCatalogAgents,
      resolveLiveRoomAgentSelectors,
    } = await import('../src/lib/live-room-members');
    const options = await deriveGatewayHarnessOptions();
    assert.deepEqual(
      options.map((option) => option.harnessType).sort(),
      [...harnessTypes].sort(),
    );

    const catalog = await listLiveRoomCatalogAgents();
    const kimi = catalog.find((agent) => agent.harnessType === 'kimi-code');
    assert.equal(kimi?.id, 'platform_local:platform-local:kimi-code');
    assert.equal(kimi?.hostname, 'test-host');
    assert.deepEqual(
      await resolveLiveRoomAgentSelectors([
        'local:kimi-code',
        'platform-local:test-host:kimi-code',
        'kimi-code@test-host',
      ]),
      ['platform_local:platform-local:kimi-code'],
    );
  } finally {
    realAgentsModule.getRealAgentsStatus = originalGetRealAgentsStatus;
    platformLocalModule.ensurePlatformLocalAgents = originalEnsurePlatformLocalAgents;
    platformLocalModule.getServerHostname = originalGetServerHostname;
    prisma.gateway.findMany = originalGatewayFindMany;
    prisma.remoteHarnessHost.findMany = originalRemoteHostFindMany;
    prisma.agent.findMany = originalAgentFindMany;
  }
})();
