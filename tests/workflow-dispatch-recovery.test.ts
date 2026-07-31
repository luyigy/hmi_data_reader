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
  let fault: 'rotation' | 'feishu' | 'prompt' | 'reply' | null = null;
  let feishuPosts = 0;
  let promptPosts = 0;
  let replyQueues = 0;
  let rotationDecisions = 0;
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
    sourceTask: { id: 'task' },
    members: [{ id: 'user', memberType: 'user' }],
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
      config: { execution_policy: { preset: 'workspace' } },
    }],
  };
  projectConfig.loadProjectsConfig = async () => ({ projects: [project] });

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
