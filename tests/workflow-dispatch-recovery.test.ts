import assert from 'node:assert/strict';

type Dispatch = {
  id: string;
  projectId: string;
  jobId: string;
  eventKey: string;
  state: string;
  roomId: string | null;
  feishuMessageId: string | null;
  messageId: string | null;
};

async function main() {
  let dispatch!: Dispatch;
  let messageExists = false;
  let deliveryExists = false;
  let fault: 'rotation' | 'rotation_run' | 'rotation_complete' | 'feishu' | 'prompt' | 'reply' | null = null;
  let feishuPosts = 0;
  let promptPosts = 0;
  let replyQueues = 0;
  let rotationDecisions = 0;
  let rotationRuns = 0;
  let rotationAction: 'reuse' | 'prepare_checkpoint' | 'rotation_pending' | 'warning_only' = 'reuse';
  let workflowAutonomy = 'manual';
  const reset = (state: string): Dispatch => (dispatch = {
    id: 'dispatch',
    projectId: 'project',
    jobId: 'workflow',
    eventKey: 'event',
    state,
    roomId: state === 'prompt_posted' || state === 'reply_queued' ? 'room' : null,
    feishuMessageId: ['feishu_posted', 'prompt_posted', 'reply_queued'].includes(state) ? 'feishu-1' : null,
    messageId: state === 'prompt_posted' || state === 'reply_queued' ? 'message-1' : null,
  });

  const prismaModule = await import('../src/lib/prisma') as unknown as { prisma: Record<string, unknown> };
  prismaModule.prisma = {
    workflowDispatch: {
      upsert: async () => dispatch,
      update: async ({ data }: { data: Partial<Dispatch> }) => {
        dispatch = { ...dispatch, ...data };
        if (data.state === 'rotation_not_required') rotationDecisions += 1;
        if (data.state === 'rotation_not_required' && fault === 'rotation') {
          throw new Error('crash after rotation decision');
        }
        if (data.state === 'rotation_completed' && fault === 'rotation_complete') {
          throw new Error('crash after rotation completion');
        }
        return dispatch;
      },
      updateMany: async ({ where, data }: {
        where: { state: string };
        data: Partial<Dispatch>;
      }) => {
        if (dispatch.state !== where.state) return { count: 0 };
        dispatch = { ...dispatch, ...data };
        return { count: 1 };
      },
    },
    scheduledJobState: { findUnique: async () => null },
    taskRun: { count: async () => 0 },
    liveRoomMessage: {
      findFirst: async () => messageExists ? { id: 'message-1' } : null,
    },
    liveRoomDelivery: {
      findFirst: async () => deliveryExists ? { id: 'delivery-1' } : null,
    },
  };

  const room = {
    id: 'room',
    title: 'Room',
    workingDirectory: '/workspace',
    sourceTask: { id: 'task', name: 'Task', workingDirectory: '/workspace' },
    members: [
      { id: 'user', memberType: 'user' },
      {
        id: 'agent',
        memberType: 'local_agent',
        displayName: 'Codex',
        userNickname: 'Codex',
        backend: 'platform_local',
        harnessType: 'codex',
        gatewayId: null,
        roleLabel: null,
        role: 'custom',
        runtimeAgentId: null,
        codexModel: null,
        codexReasoningEffort: null,
        joinStatus: 'joined',
        presenceStatus: 'online',
        canReply: true,
        gateway: null,
      },
    ],
  };
  const liveRoomBinding = await import('../src/lib/feishu-live-room') as unknown as Record<string, unknown>;
  liveRoomBinding.getBoundLiveRoom = async () => room;
  const feishuApi = await import('../src/lib/feishu-api') as unknown as Record<string, unknown>;
  feishuApi.sendFeishuInteractiveMessage = async () => {
    feishuPosts += 1;
    if (fault === 'feishu') throw new Error('crash after Feishu post');
    return 'feishu-1';
  };
  const liveRoom = await import('../src/lib/live-room-messages') as unknown as Record<string, unknown>;
  liveRoom.postLiveRoomMessage = async () => {
    promptPosts += 1;
    messageExists = true;
    if (fault === 'prompt') throw new Error('crash after prompt post');
    return { id: 'message-1' };
  };
  const delivery = await import('../src/lib/live-room-delivery') as unknown as Record<string, unknown>;
  delivery.triggerLiveRoomMessageReplies = async () => {
    replyQueues += 1;
    deliveryExists = true;
    if (fault === 'reply') throw new Error('crash after reply queue');
  };
  const projectConfig = await import('../src/lib/scheduled-jobs/project-config') as unknown as Record<string, unknown>;
  const project = {
    id: 'project',
    path: '/workspace',
    jobs: [{
      id: 'workflow',
      type: 'workflow_watcher',
      config: {
        execution_policy: { preset: 'workspace' },
        get workflow_autonomy() { return workflowAutonomy; },
      },
    }],
    feishu: { approver_open_ids: ['approver'] },
  };
  projectConfig.loadProjectsConfig = async () => ({ projects: [project] });

  const rotationModule = await import('../src/lib/workflow-session-rotation') as unknown as Record<string, unknown>;
  rotationModule.evaluateWorkflowRoomRotation = async () => ({
    thresholds: {
      checkpointPreparationPercentage: 65,
      rotationPendingPercentage: 70,
      highPriorityPercentage: 85,
    },
    decision: {
      action: rotationAction,
      maximumUsagePercentage: rotationAction === 'rotation_pending' ? 86 : 40,
      highPriority: rotationAction === 'rotation_pending',
      dominant: null,
      samples: [],
    },
  });
  const newSession = await import('../src/lib/feishu-new-session') as unknown as Record<string, unknown>;
  newSession.prepareWorkflowRotationHandover = async () => 'docs/001_HANDOVER_20260731_fixture.md';
  newSession.collectNewSessionRisks = async () => ({
    risks: [],
    taskRuns: 0,
    deliveries: 0,
    status: '',
    unfinishedPlan: null,
    head: 'head',
  });
  newSession.handleNewSessionCommand = async () => {
    rotationRuns += 1;
    if (fault === 'rotation_run') throw new Error('crash after rotation claim');
    return '✅ rotated';
  };

  const { runWorkflowInBoundLiveRoom } = await import('../src/lib/feishu-workflow');
  const run = () => runWorkflowInBoundLiveRoom({
    projectId: 'project',
    jobId: 'workflow',
    chatId: 'chat',
    chatType: 'p2p',
    prompt: 'S02',
    executionPolicy: { preset: 'workspace' },
    eventKey: 'event',
    signal: new AbortController().signal,
  });

  reset('prepared');
  fault = 'rotation';
  await assert.rejects(run(), /crash after rotation decision/);
  assert.equal(dispatch.state, 'rotation_not_required');
  fault = null;
  assert.equal(await run(), true);
  assert.equal(dispatch.state, 'reply_queued');
  messageExists = false;
  deliveryExists = false;
  reset('prepared');
  assert.equal(await run(), true);
  assert.equal(rotationDecisions, 2, 'consecutive slices must record reuse without resetting TaskSession');

  workflowAutonomy = 'auto';
  rotationAction = 'rotation_pending';
  reset('prepared');
  fault = 'rotation_run';
  await assert.rejects(run(), /crash after rotation claim/);
  assert.equal(dispatch.state, 'rotation_pending', 'claim must be durable before stop/reset/start');
  fault = null;
  assert.equal(await run(), true);
  assert.equal(dispatch.state, 'reply_queued');
  assert.equal(rotationRuns, 2, 'rotation_pending retry must reuse the event-keyed reset checkpoints');

  messageExists = false;
  deliveryExists = false;
  reset('prepared');
  fault = 'rotation_complete';
  await assert.rejects(run(), /crash after rotation completion/);
  assert.equal(dispatch.state, 'rotation_completed');
  fault = null;
  assert.equal(await run(), true);
  assert.equal(dispatch.state, 'reply_queued');

  workflowAutonomy = 'manual';
  messageExists = false;
  deliveryExists = false;
  reset('prepared');
  fault = 'feishu';
  await assert.rejects(run(), /crash after Feishu post/);
  assert.equal(dispatch.state, 'rotation_confirmation_posting');
  fault = null;
  await assert.rejects(run(), /rotation confirmation blocked/);

  rotationAction = 'reuse';
  reset('session_reset');
  const feishuPostsBeforeFault = feishuPosts;
  fault = 'feishu';
  await assert.rejects(run(), /crash after Feishu post/);
  assert.equal(dispatch.state, 'blocked');
  fault = null;
  await assert.rejects(run(), /dispatch blocked/);
  assert.equal(feishuPosts, feishuPostsBeforeFault + 1, 'an unconfirmed external post must not be retried');

  reset('feishu_posted');
  messageExists = false;
  deliveryExists = false;
  const promptPostsBeforeFault = promptPosts;
  fault = 'prompt';
  await assert.rejects(run(), /crash after prompt post/);
  assert.equal(dispatch.state, 'feishu_posted');
  fault = null;
  assert.equal(await run(), true);
  assert.equal(promptPosts, promptPostsBeforeFault + 1, 'eventKey checkpoint must prevent a second prompt post');

  reset('prompt_posted');
  messageExists = true;
  deliveryExists = false;
  const repliesBeforeFault = replyQueues;
  fault = 'reply';
  await assert.rejects(run(), /crash after reply queue/);
  assert.equal(dispatch.state, 'prompt_posted');
  fault = null;
  assert.equal(await run(), true);
  assert.equal(replyQueues, repliesBeforeFault + 1, 'delivery checkpoint must prevent a second reply queue');

  reset('reply_queued');
  assert.equal(await run(), true);
}

void main();
