import assert from 'node:assert/strict';
import {
  buildLiveRoomWorkflowStages,
  liveRoomWorkflowGatePassed,
  missingLiveRoomWorkflowRoles,
  parseLiveRoomPlanCommand,
  parseLiveRoomWorkflowCommand,
  planPathFrom,
  runLiveRoomWorkflow,
  selectLiveRoomPlanHost,
  workflowPlanRevisionPathFrom,
} from '../src/lib/live-room-workflows';

const member = (id: string, role: string) => ({
  id,
  displayName: id,
  backend: 'platform_local',
  harnessType: 'codex',
  gatewayId: null,
  runtimeAgentId: null,
  role,
  roleLabel: null,
  acpxPermissionConfig: null,
  codexModel: null,
  codexReasoningEffort: null,
  gateway: null,
});

assert.deepEqual(parseLiveRoomWorkflowCommand('/run feature build login'), {
  name: 'feature',
  level: 'full',
  task: 'build login',
});
assert.deepEqual(parseLiveRoomWorkflowCommand('/RUN DEBUG fix crash'), {
  name: 'debug',
  level: 'full',
  task: 'fix crash',
});
assert.deepEqual(parseLiveRoomWorkflowCommand('/run feature --level=lean implement S01'), {
  name: 'feature',
  level: 'lean',
  task: 'implement S01',
});
assert.equal(parseLiveRoomWorkflowCommand('/run feature --level=turbo implement S01'), null);
assert.equal(parseLiveRoomWorkflowCommand('/run build login'), null);
assert.deepEqual(parseLiveRoomPlanCommand('/plan --host=codex design login'), {
  host: 'codex', task: 'design login',
});
assert.deepEqual(parseLiveRoomPlanCommand('/plan --revise=docs/288_PLAN_20260728_fix.md update it'), {
  revisionPath: 'docs/288_PLAN_20260728_fix.md',
  task: 'update it',
});
assert.equal(parseLiveRoomPlanCommand('/plan --revise=../outside.md update it'), null);
assert.equal(parseLiveRoomPlanCommand('/plan'), null);
assert.equal(
  planPathFrom('PLAN_PATH: docs/codex/rebuild-postgres-auth-slice/178_PLAN_20260728_试模参数页面第三轮测试反馈修复.md'),
  'docs/codex/rebuild-postgres-auth-slice/178_PLAN_20260728_试模参数页面第三轮测试反馈修复.md'
);
assert.equal(planPathFrom('PLAN_PATH: docs/../178_PLAN_bad.md'), null);
assert.equal(
  workflowPlanRevisionPathFrom('PLAN_REVISE\nplan_path: docs/288_PLAN_20260728_fix.md\nfeedback:\nclarify'),
  'docs/288_PLAN_20260728_fix.md',
);
assert.equal(workflowPlanRevisionPathFrom('PLAN_REVISE\nplan_path: ../outside.md'), null);
assert.equal(workflowPlanRevisionPathFrom('plan_path: docs/288_PLAN_20260728_fix.md'), null);

const members = [
  member('planner', 'planner'),
  { ...member('builder', 'implementer'), harnessType: 'pi-agent' },
  member('reviewer', 'reviewer'),
  { ...member('tester', 'tester'), harnessType: 'antigravity' },
];

assert.equal(selectLiveRoomPlanHost([{ ...member('planner', 'planner'), canReply: true }]).host?.id, 'planner');
assert.match(selectLiveRoomPlanHost([
  { ...member('planner-a', 'planner'), canReply: true },
  { ...member('planner-b', 'planner'), canReply: true },
]).error || '', /--host/);
assert.equal(selectLiveRoomPlanHost([
  { ...member('planner-a', 'planner'), canReply: true },
  { ...member('codex', 'custom'), canReply: true },
], 'codex').host?.id, 'codex');

assert.deepEqual(
  buildLiveRoomWorkflowStages('feature', members).map((stage) => [
    stage.id,
    stage.member.id,
  ]),
  [
    ['plan', 'planner'],
    ['plan-review', 'reviewer'],
    ['plan-final', 'planner'],
    ['test-plan', 'tester'],
    ['implement', 'builder'],
    ['code-review', 'reviewer'],
    ['test', 'tester'],
    ['final', 'planner'],
  ]
);

assert.deepEqual(
  buildLiveRoomWorkflowStages('debug', members).map((stage) => stage.id),
  [
    'reproduce-plan',
    'fix-plan',
    'plan-review',
    'plan-final',
    'test-plan',
    'fix',
    'code-review',
    'test',
    'final',
  ]
);
assert.deepEqual(
  buildLiveRoomWorkflowStages('feature', members, 'lean').map((stage) => stage.id),
  ['plan-review', 'implement', 'test'],
);
assert.deepEqual(
  buildLiveRoomWorkflowStages('feature', members, 'fast').map((stage) => stage.id),
  ['implement', 'test'],
);
assert.deepEqual(
  buildLiveRoomWorkflowStages('feature', members, 'full', true).map((stage) => stage.id),
  ['plan-review', 'test-plan', 'implement', 'code-review', 'test'],
);

assert.deepEqual(missingLiveRoomWorkflowRoles(members), []);
assert.deepEqual(missingLiveRoomWorkflowRoles(members.filter((candidate) => candidate.role !== 'reviewer')), ['reviewer']);
assert.deepEqual(missingLiveRoomWorkflowRoles(members.filter((candidate) => candidate.role !== 'planner'), 'lean'), []);
assert.deepEqual(missingLiveRoomWorkflowRoles(members.filter((candidate) => candidate.role !== 'planner'), 'full', true), []);
assert.deepEqual(missingLiveRoomWorkflowRoles(members.filter((candidate) => candidate.role !== 'reviewer'), 'lean'), ['reviewer']);
assert.deepEqual(missingLiveRoomWorkflowRoles(members.filter((candidate) => candidate.role !== 'planner' && candidate.role !== 'reviewer'), 'fast'), []);
assert.deepEqual(missingLiveRoomWorkflowRoles([
  member('same', 'planner'),
  member('same', 'implementer'),
  member('reviewer', 'reviewer'),
  member('tester', 'tester'),
]), ['implementer']);
assert.equal(buildLiveRoomWorkflowStages('feature', members.slice(1)).length, 0);

assert.equal(liveRoomWorkflowGatePassed('plan-review', 'APPROVED'), true);
assert.equal(liveRoomWorkflowGatePassed('code-review', 'CHANGES_REQUESTED'), false);
assert.equal(liveRoomWorkflowGatePassed('code-review', 'APPROVED but not CHANGES_REQUESTED'), false);
assert.equal(liveRoomWorkflowGatePassed('test', 'PASSED'), true);
assert.equal(liveRoomWorkflowGatePassed('test', 'FAILED'), false);
assert.equal(liveRoomWorkflowGatePassed('test', 'no explicit result'), false);
assert.equal(liveRoomWorkflowGatePassed('implement', 'completed'), null);

async function verifyFailedWorkflowDefersToNextAgent() {
  let dispatchState = 'reply_queued';
  const messages: Array<{ content: string }> = [];
  const prompts: string[] = [];
  const prismaModule = await import('../src/lib/prisma') as unknown as { prisma: Record<string, unknown> };
  prismaModule.prisma = {
    $queryRaw: async () => [],
    liveRoom: { findUnique: async () => ({ id: 'room', members: members.map((item) => ({ ...item, canReply: true, joinStatus: 'joined' })) }) },
    liveRoomMessage: { findUnique: async () => ({ metadata: null }) },
    workflowDispatch: { updateMany: async ({ data }: { data: { state: string } }) => {
      dispatchState = data.state;
      return { count: 1 };
    } },
  };
  const liveRoomMembers = await import('../src/lib/live-room-members') as unknown as Record<string, unknown>;
  liveRoomMembers.syncLiveRoomSourceTask = async () => ({
    id: 'task', name: 'Task', workingDirectory: process.cwd(), acpxPermissionConfig: null, currentTaskSession: null,
  });
  const liveRoomMessages = await import('../src/lib/live-room-messages') as unknown as Record<string, unknown>;
  liveRoomMessages.postLiveRoomMessage = async (message: { content: string }) => {
    messages.push(message);
    return { id: `message-${messages.length}` };
  };
  const runner = await import('../src/lib/acpx/runner') as unknown as Record<string, unknown>;
  let runCount = 0;
  let callbacksAttached = 0;
  runner.executeAcpxTaskRun = async ({ taskDescription, streamCallbacks }: {
    taskDescription: string;
    streamCallbacks?: {
      onStdoutChunk?: (chunk: string) => void;
      onToolEvent?: (event: { toolName: string; preview: string; emoji: string }) => void;
    };
  }) => {
    runCount += 1;
    if (streamCallbacks) callbacksAttached += 1;
    streamCallbacks?.onStdoutChunk?.(`stage ${runCount} thinking.`);
    streamCallbacks?.onToolEvent?.({ toolName: 'Read', preview: 'src/file.ts', emoji: '📖' });
    prompts.push(taskDescription);
    const summary = runCount === 2 ? 'APPROVED' : runCount === 3 ? 'PASSED' : 'completed';
    return runCount === 1
      ? { taskRunId: 'run-1', status: 'failed', participants: [{ status: 'failed', error: 'harness crashed' }] }
      : { taskRunId: `run-${runCount}`, status: 'completed', participants: [{ status: 'completed', summary }] };
  };

  await runLiveRoomWorkflow({ roomId: 'room', sourceMessageId: 'source', name: 'feature', level: 'lean', task: 'test failure' });

  assert.equal(dispatchState, 'completed');
  assert.equal(runCount, 3);
  assert.equal(callbacksAttached, 3);
  assert.match(messages.find((message) => message.content.includes('职责已顺延'))?.content || '', /计划审查 \+ 功能实施/);
  assert.ok(messages.some((message) => message.content.includes('正在分析')));
  assert.ok(messages.some((message) => message.content.includes('正在使用 Read')));
  assert.match(prompts[1], /Inherited failed responsibilities/);

  dispatchState = 'reply_queued';
  messages.length = 0;
  runCount = 0;
  runner.executeAcpxTaskRun = async () => {
    runCount += 1;
    return { taskRunId: `failed-${runCount}`, status: 'failed', participants: [{ status: 'failed', error: 'still broken' }] };
  };
  await runLiveRoomWorkflow({ roomId: 'room', sourceMessageId: 'source', name: 'feature', level: 'fast', task: 'terminal failure' });
  assert.equal(runCount, 2);
  assert.equal(dispatchState, 'failed');
  assert.match(messages.at(-1)?.content || '', /停止，不再等待后续角色/);
}

void verifyFailedWorkflowDefersToNextAgent();
