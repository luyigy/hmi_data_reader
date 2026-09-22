import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'new-session-rotation-'));
  const runGit = (...args: string[]) => execFileAsync('git', args, { cwd: workspace });
  await runGit('init');
  await runGit('config', 'user.name', 'Test');
  await runGit('config', 'user.email', 'test@example.com');
  await runGit('config', 'core.hooksPath', '/dev/null');
  await fs.mkdir(path.join(workspace, 'docs'));
  await fs.writeFile(path.join(workspace, 'README.md'), 'fixture\n');
  await fs.writeFile(path.join(workspace, 'docs/001_PLAN_20260731_fixture.md'), [
    '---',
    'doc_type: PLAN',
    'doc_status: ready',
    'next_action: start_first_slice',
    'plan_kind: phase',
    '---',
    '# PLAN',
    '## S01',
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'docs/002_PLAN_20260731_completed.md'), [
    '---',
    'doc_type: PLAN',
    'doc_status: ready',
    'next_action: start_first_slice',
    'plan_kind: phase',
    '---',
    '# PLAN',
    '## S01',
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'docs/003_HANDOVER_20260731_completed.md'), [
    '---',
    'doc_type: HANDOVER',
    'doc_status: completed',
    'next_action: none',
    'plan: 002_PLAN_20260731_completed.md',
    'slice: S01',
    'plan_progress: complete',
    '---',
    '# HANDOVER',
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'docs/215_PLAN_20260722_legacy.md'), [
    '# Legacy Plan without frontmatter',
    'This file has no YAML frontmatter block.',
  ].join('\n'));
  await runGit('add', '.');
  await runGit('commit', '-m', 'fixture');
  await fs.writeFile(path.join(workspace, 'dirty.txt'), 'keep me\n');
  await fs.writeFile(path.join(workspace, 'README.md'), 'user staged change\n');
  await runGit('add', 'README.md');

  let currentRotationKey: string | null = null;
  const sessions = new Map<string, { id: string; metadata: string }>();
  const taskMessages = new Set<string>();
  const liveMarkers = new Set<string>();
  let threaded = true;
  let fault: 'before_session' | 'session' | 'marker' | 'live' | 'thread' | 'bootstrap' | 'complete' | null = null;
  let runningReply = true;
  let stopEffects = 0;
  let rotations = 0;
  let resetMarkers = 0;
  let liveResets = 0;
  let threadClears = 0;
  let threadClearTargets: string[] = [];
  let bootstrapPosts = 0;
  let confirmationCard = '';
  const replies: string[] = [];
  const permissionWrites: { memberId: string; config: string }[] = [];
  const taskPermissionWrites: string[] = [];

  const prismaModule = await import('../src/lib/prisma') as unknown as { prisma: Record<string, unknown> };
  prismaModule.prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaModule.prisma),
    taskRun: { count: async () => 1 },
    liveRoomDelivery: { count: async () => 1 },
    taskSession: {
      findFirst: async ({ where }: { where: { metadata: { contains: string } } }) => {
        const key = JSON.parse(where.metadata.contains.slice(where.metadata.contains.indexOf(':') + 1));
        currentRotationKey = key;
        return sessions.get(key) || null;
      },
      update: async ({ data }: { data: { metadata: string } }) => {
        const session = sessions.get(currentRotationKey!);
        if (session) session.metadata = data.metadata;
        if (fault === 'complete') throw new Error('crash after completion checkpoint');
        return session;
      },
    },
    task: { update: async ({ data }: { data: { acpxPermissionConfig?: string } }) => {
      if (data.acpxPermissionConfig) taskPermissionWrites.push(data.acpxPermissionConfig);
      return {};
    } },
    liveRoomMember: { update: async ({ where, data }: {
      where: { id: string; roomId: string }; data: { acpxPermissionConfig: string };
    }) => {
      assert.equal(where.roomId, 'room');
      permissionWrites.push({ memberId: where.id, config: data.acpxPermissionConfig });
      return {};
    } },
    message: {
      findFirst: async ({ where }: { where: { userId?: string; content: string | { contains: string } } }) => {
        const content = typeof where.content === 'string' ? where.content : where.content.contains;
        return (where.userId === 'system'
          ? taskMessages.has(`marker:${content}`)
          : taskMessages.has(content)) ? { id: 'message' } : null;
      },
    },
    liveRoomMessage: {
      findFirst: async ({ where }: { where: { metadata: { contains: string } } }) =>
        liveMarkers.has(where.metadata.contains) ? { id: 'live-reset' } : null,
    },
    liveRoomMemberSession: {
      count: async () => threaded ? 1 : 0,
      updateMany: async ({ where }: { where: { memberId: { in: string[] } } }) => {
        threaded = false;
        threadClears += 1;
        threadClearTargets = where.memberId.in;
        if (fault === 'thread') throw new Error('crash after thread cleanup');
        return { count: 1 };
      },
    },
  };

  const room = {
    id: 'room',
    title: 'Room',
    workingDirectory: workspace,
    sourceTask: {
      id: 'task',
      name: 'Task',
      workingDirectory: workspace,
      acpxPermissionConfig: null as string | null,
    },
    members: [{
      id: 'member',
      memberType: 'local_agent',
      canReply: true,
      displayName: 'Codex',
      userNickname: 'Codex',
      backend: 'platform_local',
      harnessType: 'codex',
      gateway: null,
      gatewayId: null,
      runtimeAgentId: null,
      acpxPermissionConfig: JSON.stringify({ profile: 'dev_local', writableRoots: [workspace] }),
    }],
  };
  const binding = await import('../src/lib/feishu-live-room') as unknown as Record<string, unknown>;
  binding.getBoundLiveRoom = async () => room;
  binding.resolveRoomMemberQuery = () => room.members[0];

  const session = await import('../src/lib/acpx/session') as unknown as Record<string, unknown>;
  session.rotateTaskSession = async (_taskId: string, options: { metadata: Record<string, unknown> }) => {
    if (fault === 'before_session') throw new Error('crash before TaskSession creation');
    rotations += 1;
    const created = {
      id: `session-${rotations}`,
      metadata: JSON.stringify(options.metadata),
    };
    sessions.set(String(options.metadata.rotationKey), created);
    if (fault === 'session') throw new Error('crash after session creation');
    return created;
  };

  const taskRoom = await import('../src/lib/task-room') as unknown as Record<string, unknown>;
  taskRoom.ensureTaskChatRoom = async () => ({ id: 'task-room' });
  taskRoom.buildTaskRoomPromptContext = async () => ({
    transcript: [
      'recent context',
      '<!-- WORKFLOW_PROMPT_START -->',
      '读取 docs/dev/001_PLAN_20260731_fixture.md，只执行 S01。',
      '<!-- WORKFLOW_PROMPT_END -->',
      'WORKFLOW_READY abcdef 001_PLAN_20260731_fixture.md',
    ].join('\n'),
    latestUserMessage: null,
  });
  taskRoom.postTaskRoomSessionResetMarker = async ({ sessionId }: { sessionId: string }) => {
    resetMarkers += 1;
    taskMessages.add(`marker:${sessionId}`);
    if (fault === 'marker') throw new Error('crash after reset marker');
  };
  taskRoom.postTaskRoomMessage = async ({ content }: { content: string }) => {
    bootstrapPosts += 1;
    taskMessages.add(content);
    if (fault === 'bootstrap') {
      fault = null;
      throw new Error('crash after bootstrap');
    }
    return { id: `task-message-${bootstrapPosts}` };
  };

  const liveRoomMembers = await import('../src/lib/live-room-members') as unknown as Record<string, unknown>;
  liveRoomMembers.buildLiveRoomAcpxParticipant = () => ({
    id: 'member',
    backend: 'platform_local',
    harnessType: 'codex',
  });
  const liveRoomMessages = await import('../src/lib/live-room-messages') as unknown as Record<string, unknown>;
  liveRoomMessages.postLiveRoomMessage = async ({ metadata }: { metadata: { rotationKey: string } }) => {
    liveResets += 1;
    liveMarkers.add(`"rotationKey":${JSON.stringify(metadata.rotationKey)}`);
    if (fault === 'live') throw new Error('crash after live reset');
    return { id: 'live-reset' };
  };

  const interrupt = await import('../src/lib/live-room-interrupt') as unknown as Record<string, unknown>;
  interrupt.interruptLiveRoomMemberReplies = async () => {
    if (!runningReply) {
      return { failedRunningCount: 0, interruptedRunningCount: 0, cancelledQueuedCount: 0 };
    }
    runningReply = false;
    stopEffects += 1;
    return { failedRunningCount: 0, interruptedRunningCount: 1, cancelledQueuedCount: 1 };
  };
  const registry = await import('../src/lib/live-room-process-registry') as unknown as Record<string, unknown>;
  registry.cancelQueuedLiveRoomMemberExecutions = () => {};
  registry.waitForLiveRoomMemberExecutionStop = async () => {};

  const api = await import('../src/lib/feishu-api') as unknown as Record<string, unknown>;
  api.sendFeishuInteractiveMessage = async ({ card }: { card: Record<string, unknown> }) => {
    confirmationCard = JSON.stringify(card);
    return 'card';
  };
  api.sendFeishuTextMessage = async ({ text }: { text: string }) => {
    replies.push(text);
  };

  const {
    handleNewSessionCommand,
    handleNewSessionConfirmationCardAction,
    prepareWorkflowRotationHandover,
  } = await import('../src/lib/feishu-new-session');
  const context = {
    chatId: 'chat',
    chatType: 'group',
    senderOpenId: 'user',
    messageId: 'message',
  };
  const command = { command: 'new-session', args: [], options: {} };

  const preclaimHandover = await prepareWorkflowRotationHandover({
    taskId: 'task',
    taskName: 'Task',
    roomId: 'room',
    roomTitle: 'Room',
    workingDirectory: workspace,
    memberIds: ['member'],
    memberNames: ['Codex'],
    rotationKey: 'preclaim-crash',
  });
  const preclaimHead = (await runGit('rev-parse', 'HEAD')).stdout.trim();
  assert.equal(await prepareWorkflowRotationHandover({
    taskId: 'task',
    taskName: 'Task',
    roomId: 'room',
    roomTitle: 'Room',
    workingDirectory: workspace,
    memberIds: ['member'],
    memberNames: ['Codex'],
    rotationKey: 'preclaim-crash',
  }), preclaimHandover);
  assert.equal((await runGit('rev-parse', 'HEAD')).stdout.trim(), preclaimHead,
    'retry after pre-claim crash must reuse the committed Handover');
  const preclaimContent = await fs.readFile(path.join(workspace, preclaimHandover), 'utf8');
  assert.ok(!preclaimContent.includes('<!-- WORKFLOW_PROMPT_START -->'),
    'emergency checkpoint must not repeat raw workflow prompt markers');
  assert.ok(!preclaimContent.includes('<!-- WORKFLOW_PROMPT_END -->'),
    'emergency checkpoint must not repeat raw workflow prompt markers');
  assert.match(preclaimContent, /WORKFLOW_PROMPT_START 标记已脱敏/);
  assert.match(preclaimContent, /WORKFLOW_READY abcdef/);

  assert.equal(rotations, 0);
  assert.deepEqual(await handleNewSessionConfirmationCardAction({
    value: {
      decision: 'direct',
      requesterOpenId: 'user',
      command: JSON.stringify(command),
      rotationKey: 'forbidden',
    },
    openId: 'other-user',
    chatId: 'chat',
  }), { toast: { type: 'warning', content: '确认卡已失效或只能由原请求人操作' } });
  assert.deepEqual(await handleNewSessionConfirmationCardAction({
    value: {
      decision: 'cancel',
      requesterOpenId: 'user',
      command: JSON.stringify(command),
      rotationKey: 'cancel',
    },
    openId: 'user',
    chatId: 'chat',
  }), { toast: { type: 'success', content: '已取消；未停止运行，也未切换 Session' } });
  assert.equal(rotations, 0);

  const confirmed = {
    ...command,
    options: { confirmed: 'true', 'rotation-key': 'recover' },
  };
  for (const [checkpoint, error] of [
    ['before_session', /before TaskSession creation/],
    ['session', /session creation/],
    ['marker', /reset marker/],
    ['live', /live reset/],
    ['thread', /thread cleanup/],
    ['bootstrap', /bootstrap/],
    ['complete', /completion checkpoint/],
  ] as const) {
    fault = checkpoint;
    await assert.rejects(handleNewSessionCommand(confirmed, context), error);
  }
  fault = null;
  assert.match(await handleNewSessionCommand(confirmed, context), /^✅/);
  assert.equal(rotations, 1);
  assert.equal(resetMarkers, 1);
  assert.equal(liveResets, 1);
  assert.equal(threadClears, 1);
  assert.equal(bootstrapPosts, 2);
  assert.equal(stopEffects, 1, 'retry after a durable stop must not stop the old run twice');

  room.members.push(
    {
      ...room.members[0],
      id: 'kimi-member',
      displayName: 'Kimi',
      userNickname: 'Kimi',
      harnessType: 'kimi-code',
    },
    {
      ...room.members[0],
      id: 'antigravity-member',
      displayName: 'Antigravity',
      userNickname: 'Antigravity',
      harnessType: 'antigravity',
    },
  );
  threaded = true;
  const allResult = await handleNewSessionCommand({
    ...command,
    options: {
      all: 'true',
      blank: 'true',
      confirmed: 'true',
      'rotatable-only': 'true',
      'rotation-key': 'workflow-event',
    },
  }, context);
  assert.match(allResult, /全部 2 个 agent/);
  assert.deepEqual(threadClearTargets, ['member', 'kimi-member']);
  assert.ok(Array.from(taskMessages).some((content) => content.includes('Kimi <- blank bootstrap')));
  assert.ok(!Array.from(taskMessages).some((content) => content.includes('Antigravity <-')));

  const beforeHead = (await runGit('rev-parse', 'HEAD')).stdout.trim();
  await handleNewSessionConfirmationCardAction({
    value: {
      decision: 'handover',
      requesterOpenId: 'user',
      chatType: 'group',
      command: JSON.stringify(command),
      rotationKey: 'handover',
    },
    openId: 'user',
    chatId: 'chat',
    messageId: 'card',
  });
  const afterHead = (await runGit('rev-parse', 'HEAD')).stdout.trim();
  assert.notEqual(afterHead, beforeHead);
  assert.match((await runGit('show', '--format=', '--name-only', 'HEAD')).stdout, /_HANDOVER_/);
  assert.equal(await fs.readFile(path.join(workspace, 'dirty.txt'), 'utf8'), 'keep me\n');
  assert.match((await runGit('diff', '--cached', '--name-only')).stdout, /README\.md/);
  assert.match(replies.at(-1) || '', /^✅/);

  let startedCalled = false;
  const asyncResult = await handleNewSessionConfirmationCardAction({
    value: {
      decision: 'handover',
      requesterOpenId: 'user',
      chatType: 'group',
      command: JSON.stringify(command),
      rotationKey: 'async-handover-end',
    },
    openId: 'user',
    chatId: 'chat',
    messageId: 'card-async',
    onStarted: () => { startedCalled = true; },
    asyncProcessing: true,
  });
  assert.equal(startedCalled, true);
  assert.equal(asyncResult.toast.type, 'success');
  assert.match(asyncResult.toast.content, /已开始生成 Handover/);
  await new Promise((resolve) => setTimeout(resolve, 200));

  let startedDecision: string | null = null;
  const headBeforeDirect = (await runGit('rev-parse', 'HEAD')).stdout.trim();
  const directAsyncResult = await handleNewSessionConfirmationCardAction({
    value: {
      decision: 'direct',
      requesterOpenId: 'user',
      chatType: 'group',
      command: JSON.stringify({
        ...command,
        options: { 'generate-handover': 'true', handover: 'stale' },
      }),
      rotationKey: 'async-direct-end',
    },
    openId: 'user',
    chatId: 'chat',
    messageId: 'card-direct-async',
    onStarted: (decision) => { startedDecision = decision; },
    asyncProcessing: true,
  });
  assert.equal(startedDecision, 'direct');
  assert.equal(directAsyncResult.toast.type, 'success');
  assert.equal(directAsyncResult.toast.content, '已开始切换 Session...');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const headAfterDirect = (await runGit('rev-parse', 'HEAD')).stdout.trim();
  assert.equal(headAfterDirect, headBeforeDirect, 'direct switch must not generate or commit any handover doc');
  assert.match(replies.at(-1) || '', /^✅/);
  assert.match(replies.at(-1) || '', /Bootstrap：room\/task state/);

  const directCmdResult = await handleNewSessionCommand({
    command: 'new-session',
    args: [],
    options: {
      direct: 'true',
      'rotation-key': 'cmd-direct',
    },
  }, context);
  assert.match(directCmdResult, /^✅/);
  assert.match(directCmdResult, /Bootstrap：room\/task state/);
  assert.equal((await runGit('rev-parse', 'HEAD')).stdout.trim(), headBeforeDirect);

  assert.equal(permissionWrites.length, 0, 'rotation without a profile must preserve member permissions');
  assert.equal(taskPermissionWrites.length, 0);
  room.sourceTask.acpxPermissionConfig = JSON.stringify({ profile: 'full_access' });
  const { buildFullAccessApprovedCommand } = await import('../src/lib/feishu-access-approval');
  const permissionCommand = buildFullAccessApprovedCommand({ command: 'rights', args: [], options: {} });
  permissionCommand.options['rotation-key'] = 'permission-repair';
  threaded = true;
  await handleNewSessionCommand(permissionCommand, context);
  assert.deepEqual(permissionWrites.map(({ memberId }) => memberId), room.members.map(({ id }) => id));
  assert.equal(JSON.parse(taskPermissionWrites.at(-1)!).profile, 'full_access');
  assert.deepEqual(threadClearTargets, room.members.map(({ id }) => id));
  for (const { config } of permissionWrites) {
    assert.equal(JSON.parse(config).profile, 'full_access', 'repair stale members even when task already has full access');
    assert.equal(JSON.parse(config).sandboxMode, 'danger-full-access');
    assert.deepEqual(JSON.parse(config).writableRoots, [workspace]);
  }
  const rotationsBeforeRetry = rotations;
  permissionWrites.length = 0;
  await handleNewSessionCommand(permissionCommand, context);
  assert.equal(rotations, rotationsBeforeRetry, 'retry must reuse the rotated session');
  assert.equal(permissionWrites.length, 3, 'retry must still synchronize member permissions');

  const targetedOptions: Record<string, string>[] = [
    { agent: 'Codex', all: 'false' },
    { 'rotatable-only': 'true', all: 'true' },
  ];
  for (const options of targetedOptions) {
    permissionWrites.length = 0;
    const taskWritesBefore: number = taskPermissionWrites.length;
    await handleNewSessionCommand({
      ...command,
      options: { direct: 'true', profile: 'safe', 'rotation-key': JSON.stringify(options), ...options },
    }, context);
    assert.deepEqual(permissionWrites.map(({ memberId }) => memberId),
      options.agent ? ['member'] : ['member', 'kimi-member']);
    assert.equal(taskPermissionWrites.length, taskWritesBefore, 'excluded members must retain inherited permissions');
    assert.ok(permissionWrites.every(({ config }) => JSON.parse(config).profile === 'safe_local'));
  }

  // Default rotation must bypass the gate even with dirty files, an unfinished
  // PLAN and running work; it must also work without a Git repository or HEAD.
  const docsBeforeDefault = await fs.readdir(path.join(workspace, 'docs'));
  const headBeforeDefault = (await runGit('rev-parse', 'HEAD')).stdout.trim();
  const nonGitWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'session-no-git-'));
  for (const index of [0, 1, 2]) {
    const directory = index === 0 ? workspace : nonGitWorkspace;
    if (index === 2) {
      await execFileAsync('git', ['init'], { cwd: directory });
    }
    room.workingDirectory = directory;
    runningReply = true;
    const stopsBefore: number = stopEffects;
    const rotationsBefore: number = rotations;
    const result = await handleNewSessionCommand(command, {
      ...context, messageId: `default-${index}`,
    });
    assert.match(result, /^✅/);
    assert.match(result, /Bootstrap：room\/task state/);
    assert.equal(rotations, rotationsBefore + 1);
    assert.equal(stopEffects, stopsBefore + 1, 'default rotation must still stop old work');
    assert.equal(confirmationCard, '', 'default rotation must not send a gate card');
  }
  assert.deepEqual(await fs.readdir(path.join(workspace, 'docs')), docsBeforeDefault);
  assert.equal((await runGit('rev-parse', 'HEAD')).stdout.trim(), headBeforeDefault);
  assert.deepEqual(await fs.readdir(nonGitWorkspace), ['.git'], 'no handover docs should be created');
  await fs.rm(nonGitWorkspace, { recursive: true, force: true });

  await fs.rm(workspace, { recursive: true, force: true });
  console.log('new session rotation checks passed');
}

void main();
