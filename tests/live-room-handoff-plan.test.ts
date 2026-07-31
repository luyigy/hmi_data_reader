import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  formatLiveRoomHandoffTranscript,
  handoffPlanEventKey,
  promoteLiveRoomHandoffToPlan,
  selectLiveRoomHandoffTranscript,
} from '../src/lib/live-room-handoff-plan';
import * as runnerModule from '../src/lib/acpx/runner';
import * as feishuLiveRoomModule from '../src/lib/feishu-live-room';
import * as liveRoomMessagesModule from '../src/lib/live-room-messages';
import { prisma } from '../src/lib/prisma';

const execFileAsync = promisify(execFile);

const message = (
  id: string,
  content: string,
  options: {
    root?: string;
    metadataRoot?: string;
    type?: string;
    sender?: string;
  } = {},
) => ({
  id,
  handoffRootMessageId: options.root || null,
  content,
  messageType: options.type || 'assistant',
  metadata: options.metadataRoot
    ? JSON.stringify({ handoffRootMessageId: options.metadataRoot })
    : null,
  senderMember: options.sender ? { displayName: options.sender } : null,
});

const messages = [
  message('unrelated', 'ignore me', { type: 'user' }),
  message('root-1', 'please discuss the workflow', { type: 'user', sender: '用户' }),
  message('reply-1', 'first analysis', { root: 'root-1', sender: 'Codex' }),
  message('reply-2', 'final recommendation', { metadataRoot: 'root-1', sender: 'Claude' }),
];
const transcript = selectLiveRoomHandoffTranscript(messages, 'root-1');

assert.deepEqual(transcript.map(({ id }) => id), ['root-1', 'reply-1', 'reply-2']);
assert.equal(
  formatLiveRoomHandoffTranscript(transcript),
  '[用户]\nplease discuss the workflow\n\n[Codex]\nfirst analysis\n\n[Claude]\nfinal recommendation',
);
assert.equal(
  handoffPlanEventKey('room-1', 'root-1'),
  handoffPlanEventKey('room-1', 'root-1'),
  'duplicate clicks must resolve to the same promotion event',
);
assert.notEqual(
  handoffPlanEventKey('room-1', 'root-1'),
  handoffPlanEventKey('room-1', 'root-2'),
);

const checkPromotionIdempotency = async () => {
  const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-plan-'));
  const dispatch = {
    id: 'dispatch-1',
    projectId: 'task-1',
    jobId: 'live_room_handoff_plan',
    eventKey: handoffPlanEventKey('room-1', 'root-1'),
    state: 'prepared',
    roomId: 'room-1',
    messageId: null as string | null,
  };
  const receipts: Array<{ id: string; metadata: string }> = [];
  let runs = 0;
  let startedNotices = 0;
  const feishuLiveRoom = feishuLiveRoomModule as unknown as {
    getBoundLiveRoom: (...args: unknown[]) => Promise<unknown>;
  };
  const runner = runnerModule as unknown as {
    executeAcpxTaskRun: (...args: unknown[]) => Promise<unknown>;
  };
  const liveRoomMessages = liveRoomMessagesModule as unknown as {
    postLiveRoomMessage: (args: Record<string, unknown>) => Promise<unknown>;
  };
  type AsyncStoreMethod = (...args: unknown[]) => Promise<unknown>;
  const stores = prisma as unknown as {
    workflowDispatch: Record<string, AsyncStoreMethod>;
    liveRoomMessage: Record<string, AsyncStoreMethod>;
  };
  const originalGetBoundLiveRoom = feishuLiveRoom.getBoundLiveRoom;
  const originalExecute = runner.executeAcpxTaskRun;
  const originalPost = liveRoomMessages.postLiveRoomMessage;
  const originalDispatchUpsert = stores.workflowDispatch.upsert;
  const originalDispatchUpdateMany = stores.workflowDispatch.updateMany;
  const originalDispatchUpdate = stores.workflowDispatch.update;
  const originalMessageFindMany = stores.liveRoomMessage.findMany;
  const originalMessageFindUnique = stores.liveRoomMessage.findUnique;

  try {
    await execFileAsync('git', ['init'], { cwd: workingDirectory });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workingDirectory });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDirectory });
    await execFileAsync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: workingDirectory });
    await fs.writeFile(path.join(workingDirectory, 'README.md'), 'fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: workingDirectory });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: workingDirectory });

    feishuLiveRoom.getBoundLiveRoom = async () => ({
      id: 'room-1',
      sourceTask: {
        id: 'task-1',
        name: 'fixture',
        workingDirectory,
        currentTaskSession: null,
        acpxPermissionConfig: null,
      },
      members: [{
        id: 'planner-1',
        memberType: 'local_agent',
        canReply: true,
        harnessType: 'codex',
        backend: 'platform_local',
        displayName: 'Codex',
        gatewayId: null,
        runtimeAgentId: null,
        role: 'planner',
        roleLabel: null,
        acpxPermissionConfig: null,
        codexModel: null,
        codexReasoningEffort: null,
        gateway: null,
      }],
    });
    runner.executeAcpxTaskRun = async () => {
      runs += 1;
      const planPath = 'docs/901_PLAN_20260731_HandoffFixture.md';
      await fs.mkdir(path.join(workingDirectory, 'docs'));
      await fs.writeFile(path.join(workingDirectory, planPath), [
        '---',
        'doc_type: PLAN',
        'doc_status: ready',
        'next_action: start_first_slice',
        'plan_kind: phase',
        '---',
        '<!-- HANDOFF_PLAN_SOURCE: root-1 -->',
      ].join('\n'));
      return {
        participants: [{ status: 'completed', summary: `PLAN_PATH: ${planPath}` }],
      };
    };
    liveRoomMessages.postLiveRoomMessage = async (args) => {
      const receipt = {
        id: `receipt-${receipts.length + 1}`,
        metadata: JSON.stringify(args.metadata || null),
      };
      receipts.push(receipt);
      return receipt;
    };
    stores.workflowDispatch.upsert = async () => ({ ...dispatch });
    stores.workflowDispatch.updateMany = async () => {
      if (!['prepared', 'failed'].includes(dispatch.state)) return { count: 0 };
      dispatch.state = 'running';
      return { count: 1 };
    };
    stores.workflowDispatch.update = async (...callArgs) => {
      const args = callArgs[0] as { data: { state?: unknown; messageId?: unknown } };
      if (typeof args.data.state === 'string') dispatch.state = args.data.state;
      if (typeof args.data.messageId === 'string') dispatch.messageId = args.data.messageId;
      return { ...dispatch };
    };
    stores.liveRoomMessage.findMany = async (...callArgs) => {
      const args = callArgs[0] as { where?: { messageType?: string } };
      if (args.where?.messageType === 'system') return receipts;
      return messages;
    };
    stores.liveRoomMessage.findUnique = async () =>
      receipts.find(({ id }) => id === dispatch.messageId) || null
    ;

    const context = {
      chatId: 'chat-1',
      chatType: 'group',
      senderOpenId: 'user-1',
      messageId: 'card-1',
    };
    const first = await promoteLiveRoomHandoffToPlan({
      roomId: 'room-1',
      rootMessageId: 'root-1',
      context,
      onStarted: () => {
        startedNotices += 1;
      },
    });
    dispatch.state = 'running';
    dispatch.messageId = null;
    receipts.length = 0;
    const recovered = await promoteLiveRoomHandoffToPlan({
      roomId: 'room-1',
      rootMessageId: 'root-1',
      context,
    });
    const duplicate = await promoteLiveRoomHandoffToPlan({
      roomId: 'room-1',
      rootMessageId: 'root-1',
      context,
    });
    assert.match(first, /审批 PLAN 已提交/);
    assert.match(recovered, /已恢复/);
    assert.match(duplicate, /已生成审批 PLAN/);
    assert.equal(runs, 1);
    assert.equal(startedNotices, 1);
    assert.equal(receipts.length, 1);
    assert.equal((await execFileAsync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: workingDirectory,
    })).stdout.trim(), '2');
  } finally {
    feishuLiveRoom.getBoundLiveRoom = originalGetBoundLiveRoom;
    runner.executeAcpxTaskRun = originalExecute;
    liveRoomMessages.postLiveRoomMessage = originalPost;
    stores.workflowDispatch.upsert = originalDispatchUpsert;
    stores.workflowDispatch.updateMany = originalDispatchUpdateMany;
    stores.workflowDispatch.update = originalDispatchUpdate;
    stores.liveRoomMessage.findMany = originalMessageFindMany;
    stores.liveRoomMessage.findUnique = originalMessageFindUnique;
    await fs.rm(workingDirectory, { recursive: true, force: true });
  }
};

checkPromotionIdempotency()
  .then(() => console.log('Live Room handoff PLAN checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
