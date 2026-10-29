import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { ensureTaskSession } from '../src/lib/acpx/session';
import { assertRoomRunAvailable } from '../src/lib/acpx/room-admission';
import { lockWriterAdmission } from '../src/lib/task-graph/writer-admission';
import type { AcpxPermissionConfig, AcpxRunRequest } from '../src/lib/acpx/types';

const children: ChildProcess[] = [];
function launch(deliveryId: string) {
  const child = fork(path.join(__dirname, 'fixtures/room-admission-worker.ts'),
    [deliveryId, JSON.stringify({ fixtureDispatch: true })], {
      execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  children.push(child);
  let log = '';
  const messages: { kind: string; error?: string; native?: string }[] = [];
  child.stdout?.on('data', data => { log += data; });
  child.stderr?.on('data', data => { log += data; });
  child.on('message', message => messages.push(message as typeof messages[number]));
  return {
    async next(kind: string) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const message = messages.find(item => item.kind === kind || item.kind === 'error');
        if (message) return message;
        if (child.exitCode !== null) throw new Error(`Worker exited: ${log}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${kind}: ${log}`);
    },
    finish: () => child.send({ action: 'finish' }),
  };
}

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'local-room-concurrency-'));
  const tasks: string[] = [], rooms: string[] = [], graphs: string[] = [];
  const permission: AcpxPermissionConfig = {
    profile: 'full_access', sandboxMode: 'danger-full-access', networkAccess: 'enabled',
    approvalPolicy: 'on-request', writableRoots: [],
  };
  async function room(directory: string, writableRoots: string[] = []) {
    mkdirSync(directory, { recursive: true });
    const task = await prisma.task.create({ data: {
      name: 'Codex across rooms', workingDirectory: directory,
      acpxPermissionConfig: JSON.stringify({ ...permission, writableRoots }),
    } });
    tasks.push(task.id);
    const session = await ensureTaskSession(task.id);
    const created = await prisma.liveRoom.create({ data: {
      title: 'Codex across rooms', sourceTaskId: task.id, workingDirectory: directory,
    } });
    rooms.push(created.id);
    const member = await prisma.liveRoomMember.create({ data: {
      roomId: created.id, memberType: 'local_agent', displayName: 'codex',
      harnessType: 'codex', backend: 'platform_local', runtimeAgentId: 'codex',
      role: 'implementer', canReply: true,
    } });
    const memberSession = await prisma.liveRoomMemberSession.create({ data: {
      roomId: created.id, memberId: member.id, backend: 'platform_local', sessionKey: `room:${member.id}`,
    } });
    return { id: created.id, taskId: task.id, sessionId: session.id, memberId: member.id, memberSessionId: memberSession.id };
  }
  async function delivery(target: Awaited<ReturnType<typeof room>>) {
    const message = await prisma.liveRoomMessage.create({ data: {
      roomId: target.id, messageType: 'user', content: 'Do this room task',
    } });
    return prisma.liveRoomDelivery.create({ data: {
      roomMessageId: message.id, targetMemberId: target.memberId, sessionId: target.memberSessionId,
    } });
  }
  try {
    const directoryA = path.join(root, 'project-a'), directoryB = path.join(root, 'project-b');
    const a = await room(directoryA), b = await room(directoryB);
    const da = await delivery(a), db = await delivery(b);
    const first = launch(da.id), second = launch(db.id);
    for (const result of await Promise.all([first.next('started'), second.next('started')])) {
      assert.equal(result.kind, 'started', `Independent full-access Codex rooms must both start: ${result.error}`);
    }
    const active = await prisma.taskRun.findMany({ where: { taskId: { in: [a.taskId, b.taskId] }, status: 'running' }, include: { participants: true } });
    assert.equal(active.length, 2);
    assert.equal(new Set(active.map(run => run.participants[0].agentId)).size, 1, 'Both rooms use the same Agent identity');
    assert.equal(new Set(active.map(run => JSON.parse(run.controlMetadata!).roomAdmission.memberId)).size, 2);
    for (const run of active) assert.equal(JSON.parse(run.controlMetadata!).permissionConfig.sandboxMode, 'danger-full-access');
    console.log('PASS same Codex identity, different rooms/projects: both full-access runs start concurrently');

    const alias = path.join(root, 'project-a-link');
    symlinkSync(directoryA, alias, 'dir');
    for (const [label, directory, writableRoots] of [
      ['same workspace', directoryA, []],
      ['ancestor workspace', root, []],
      ['child workspace', path.join(directoryA, 'child'), []],
      ['symlink workspace', alias, []],
      ['additional writable workspace', path.join(root, 'project-c'), [directoryA]],
    ] as const) {
      const target = await room(directory, [...writableRoots]);
      const attempt = await delivery(target);
      const worker = launch(attempt.id);
      const started = await worker.next('started');
      assert.equal(started.kind, 'started', `${label}: ${started.error}`);
      worker.finish(); assert.equal((await worker.next('done')).kind, 'done');
      assert.equal((await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: attempt.id } })).deliveryStatus, 'delivered');
      console.log(`PASS ordinary rooms share ${label}`);
    }

    // A graph/non-room runner arriving after an ordinary room must still check the workspace.
    const graphRequest: AcpxRunRequest = { taskId: 'graph-fixture', taskName: 'graph-fixture', workingDirectory: directoryA,
      orchestrationMode: 'single', permissionConfig: permission,
      graphExecution: { executionId: 'graph-fixture', claimToken: 'claim', revision: 1 },
      participants: [{ executionBackend: 'platform_local', gatewayId: 'platform-local', harnessType: 'codex', role: 'implementer' }] };
    await assert.rejects(prisma.$transaction(async tx => {
      await lockWriterAdmission(tx); await assertRoomRunAvailable(tx, graphRequest);
    }), /Workspace write conflict/);
    const graphRoom = await room(path.join(root, 'graph-worktree'));
    const graph = await prisma.taskGraphRun.create({ data: { parentTaskId: graphRoom.taskId, version: 1,
      requestKey: graphRoom.id, snapshotHash: 'fixture', snapshot: {}, nodes: { create: {
        key: 'T', dependsOn: [], acceptance: 'human', executions: { create: { key: 'repo', repository: root,
          gitRef: 'refs/heads/main', baseCommit: 'fixture', agentSelector: 'local:codex', status: 'claimed',
          worktreePath: path.join(root, 'graph-worktree'), claimToken: 'held' } },
      } } } });
    graphs.push(graph.id);
    const protectedAttempt = await delivery(graphRoom);
    assert.match((await launch(protectedAttempt.id).next('error')).error || '', /Workspace writer .*unknown/);
    assert.equal(await prisma.taskRun.count({ where: { taskId: graphRoom.taskId } }), 0);
    await prisma.taskGraphRun.delete({ where: { id: graph.id } }); graphs.pop();
    console.log('PASS ordinary-first graph admission rejects overlap; graph-first unreleased claim blocks ordinary room');

    // Extra resources belonging to an existing run still reserve their write scope.
    const owner = active.find(run => run.taskId === b.taskId)!;
    const resourceDirectory = path.join(root, 'shared-resource');
    await prisma.taskRun.update({ where: { id: owner.id }, data: { controlMetadata: JSON.stringify({
      ...JSON.parse(owner.controlMetadata!), resources: { writableRoots: [resourceDirectory] },
      permissionConfig: { profile: 'full_access', sandboxMode: 'danger-full-access' },
    }) } });
    const resourceTarget = await room(resourceDirectory);
    assert.match((await launch((await delivery(resourceTarget)).id).next('error')).error || '', /Workspace write conflict/);
    console.log('PASS legacy full-access metadata without writableRoots still protects supplemental resources');

    first.finish(); assert.equal((await first.next('done')).kind, 'done');
    assert.equal((await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: da.id } })).deliveryStatus, 'delivered');
    const peer = await prisma.taskRun.findUniqueOrThrow({ where: { id: owner.id } });
    assert.equal(peer.status, 'running');
    assert.equal((await prisma.taskSession.findUniqueOrThrow({ where: { id: b.sessionId } })).activeRunId, peer.id);
    const original = await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRun: { taskId: a.taskId } } });
    const native = JSON.parse(original.controlMetadata!).lastSessionId;
    assert.ok(native);
    const followup = launch((await delivery(a)).id);
    const resumed = await followup.next('started');
    assert.equal(resumed.kind, 'started', resumed.error);
    assert.equal(resumed.native, native, 'Room A keeps its own native session while room B is still running');
    followup.finish(); assert.equal((await followup.next('done')).kind, 'done');
    second.finish(); assert.equal((await second.next('done')).kind, 'done');
    assert.equal((await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: db.id } })).deliveryStatus, 'delivered');
    assert.equal(await prisma.taskRun.count({ where: { taskId: { in: [a.taskId, b.taskId] }, status: 'running' } }), 0);
    console.log('PASS independent completion and same native continuation while another room remains active');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => child.once('exit', resolve))));
    await prisma.taskGraphRun.deleteMany({ where: { id: { in: graphs } } });
    await prisma.liveRoom.deleteMany({ where: { id: { in: rooms } } });
    await prisma.task.deleteMany({ where: { id: { in: tasks } } });
    await prisma.$disconnect();
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
