import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import { triggerLiveRoomMessageReplies } from '../src/lib/live-room-delivery';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'writer-scope-'));
  const tasks: string[] = [], rooms: string[] = [], wakeups: string[] = [];
  require('../src/lib/live-room-progress').attachLiveRoomProgress = async () => ({ streamCallbacks: {}, dispose: async () => {} });
  require('../src/lib/feishu-live-room-relay').relayLiveRoomMessageToFeishu = async () => {};
  require('../src/lib/feishu-turn-card').prepareRoomTurnCard = async () => null;
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => ({ projects: [{
    id: 'fixture', name: 'fixture', path: root, ref: 'refs/heads/main', feishu: { chat_id: 'fixture', approver_open_ids: [] },
    jobs: [{ id: 'watcher', type: 'workflow_watcher', enabled: true, mode: 'active', schedule: '* * * * *', config: {} }],
  }] });
  require('../src/lib/scheduled-jobs/runner').wakeWorkflowWatcherForTaskRun = async (_db: unknown, taskId: string) => { wakeups.push(taskId); return true; };
  const adapters = ['codex', 'kimi-code'].map(type => getHarnessAdapter(type)!);
  const original = adapters.map(adapter => ({ execute: adapter.execute, resume: adapter.resume }));
  const calls: string[] = [];
  for (const adapter of adapters) {
    adapter.execute = async args => {
      assert.equal(args.context.taskEnvironment?.AP_GRAPH_WRITER_NONCE, undefined, 'Ordinary harnesses do not register graph writers');
      calls.push(args.task.id);
      return { success: true, output: '回复正常', executionTime: 1 };
    };
    adapter.resume = async args => adapter.execute(args);
  }
  try {
    for (const kind of ['conversation', 'handover']) {
      const task = await prisma.task.create({ data: { name: kind, workingDirectory: root } }); tasks.push(task.id);
      const room = await prisma.liveRoom.create({ data: { title: kind, sourceTaskId: task.id } }); rooms.push(room.id);
      const members = await Promise.all(['codex', 'kimi-code'].map(type => prisma.liveRoomMember.create({ data: {
        roomId: room.id, memberType: 'local_agent', displayName: type, harnessType: type, backend: 'platform_local',
        runtimeAgentId: type, role: 'implementer', canReply: true,
      } })));
      const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: '请回复' } });
      if (kind === 'handover') await prisma.workflowDispatch.create({ data: {
        projectId: 'fixture', jobId: 'watcher', eventKey: message.id, roomId: room.id, messageId: message.id, state: 'reply_queued',
      } });
      const unknown = { ...await createGraphWriter(), hostname: 'unobservable-historical-host' };
      const history = await prisma.taskRun.create({ data: { taskId: task.id, status: 'completed', completedAt: new Date(),
        controlMetadata: JSON.stringify({ graphWriter: unknown, workingDirectory: root }),
        participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', status: 'completed' } },
      } });
      // Reproduce a completed Codex writer blocking Kimi in the same room, then Codex again.
      for (const member of [members[1], members[0]]) {
        const before = calls.length;
        await triggerLiveRoomMessageReplies({ roomId: room.id, roomMessageId: message.id, requestedTargetMemberId: member.id, allowHandoff: false });
        let delivered = false;
        for (let attempt = 0; attempt < 300; attempt++) {
          const delivery = await prisma.liveRoomDelivery.findFirst({ where: { roomMessageId: message.id, targetMemberId: member.id } });
          assert.notEqual(delivery?.deliveryStatus, 'failed', delivery?.fallbackReason || 'Reply failed');
          if (delivery?.deliveryStatus === 'delivered') { delivered = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(delivered, true, 'Room reply reaches delivered');
        assert.equal(calls.length, before + 1);
        const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id, id: { not: history.id } }, orderBy: { createdAt: 'desc' } });
        const metadata = JSON.parse(turn.controlMetadata!);
        assert.equal(turn.status, 'completed');
        assert.equal(metadata.graphWriter, undefined);
        assert.equal(metadata.graphWriterReleased, undefined);
        assert.equal(metadata.completionOwner.kind, kind);
      }
      assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: history.id } })).controlMetadata, history.controlMetadata, 'No history migration');
      // Existing session concurrency protection still applies without graph Writer admission.
      const session = await prisma.taskSession.create({ data: { taskId: task.id } });
      const active = await prisma.taskRun.create({ data: { taskId: task.id, taskSessionId: session.id, status: 'running' } });
      const before = calls.length;
      await assert.rejects(executeAcpxTaskRun({ taskId: task.id, taskName: kind, taskSessionId: session.id, workingDirectory: root,
        participants: [{ gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', agentId: 'codex', role: 'implementer' }],
        orchestrationMode: 'single' }), /Session already has an active run/);
      assert.equal(calls.length, before);
      await prisma.taskRun.delete({ where: { id: active.id } });
      assert.equal(wakeups.filter(id => id === task.id).length, kind === 'handover' ? 2 : 0);
      console.log(`${kind}: historical Writer cannot block Kimi/Codex replies; no new Writer; session guard and completion routing preserved`);
    }
  } finally {
    adapters.forEach((adapter, index) => Object.assign(adapter, original[index]));
    await prisma.liveRoom.deleteMany({ where: { id: { in: rooms } } });
    await prisma.task.deleteMany({ where: { id: { in: tasks } } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
