import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { ensureTaskSession } from '../src/lib/acpx/session';
const children: ChildProcess[] = [];
function launch(deliveryId: string, request?: unknown) {
  const child = fork(path.join(__dirname, 'fixtures/room-admission-worker.ts'), [deliveryId, ...(request ? [JSON.stringify(request)] : [])],
    { execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let log = ''; child.stdout?.on('data', data => { log += data; }); child.stderr?.on('data', data => { log += data; });
  const messages: any[] = []; child.on('message', message => messages.push(message));
  async function next(kind: string) {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const result = messages.find(item => item.kind === kind || item.kind === 'error');
      if (result) { if (result.kind === 'error') console.log('worker rejection:', result.error); return result; }
      if (child.exitCode !== null) throw new Error(`worker exit ${child.exitCode}: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`worker timeout ${kind}: ${log}`);
  }
  return { child, next, finish: (action = 'finish') => child.send({ action }) };
}
async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'room-admission-'));
  const task = await prisma.task.create({ data: { name: 'room admission', workingDirectory: root } });
  const session = await ensureTaskSession(task.id);
  const room = await prisma.liveRoom.create({ data: { title: 'concurrent room', sourceTaskId: task.id, workingDirectory: root } });
  const members = await Promise.all(['kimi-code', 'pi-agent', 'codex', 'kimi-code'].map(harnessType => prisma.liveRoomMember.create({ data: {
    roomId: room.id, memberType: 'local_agent', displayName: harnessType === 'pi-agent' ? 'WPI' : 'Kimi',
    harnessType, backend: harnessType === 'pi-agent' ? 'remote_ssh' : 'platform_local',
    roleLabel: harnessType === 'pi-agent' ? '__remote_host__:wpi-fixture' : null, canReply: true, runtimeAgentId: harnessType,
    acpxPermissionConfig: JSON.stringify({ profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [] }),
  } })));
  const memberSessions = await Promise.all(members.map(member => prisma.liveRoomMemberSession.create({ data: {
    roomId: room.id, memberId: member.id, backend: 'platform_local', sessionKey: `room:${member.id}`,
  } })));
  async function delivery(index: number, messageId?: string) {
    const message = messageId ? { id: messageId } : await prisma.liveRoomMessage.create({ data: { roomId: room.id, content: 'hello', messageType: 'user' } });
    return prisma.liveRoomDelivery.create({ data: { roomMessageId: message.id, targetMemberId: members[index].id,
      sessionId: memberSessions[index].id, deliveryStatus: 'running' } });
  }
  try {
    const d1 = await delivery(0), d2 = await delivery(1);
    await prisma.liveRoomDelivery.updateMany({ where: { id: { in: [d1.id, d2.id] } }, data: { deliveryStatus: 'pending' } });
    const a = launch(d1.id, { fixtureDispatch: true }), b = launch(d2.id, { fixtureDispatch: true });
    assert.equal((await a.next('started')).kind, 'started');
    assert.equal((await b.next('started')).kind, 'started', 'Kimi/WPI must both enter the real runner concurrently');
    assert.equal(await prisma.taskRun.count({ where: { taskId: task.id, status: 'running' } }), 2);
    assert.equal((await prisma.taskSession.findUniqueOrThrow({ where: { id: session.id } })).activeRunId, null);
    const remoteRun = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id, status: 'running', participants: { some: { executionBackend: 'remote_ssh' } } } });
    const { cleanupFeishuOwnedStaleTaskRuns } = await import('../src/lib/feishu-startup-task-cleanup');
    await cleanupFeishuOwnedStaleTaskRuns(remoteRun.id);
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: remoteRun.id } })).status, 'running', 'No local PID is not proof that remote WPI exited');
    const duplicate = launch((await delivery(0)).id);
    assert.match((await duplicate.next('error')).error, /active run|already running/i);
    a.finish(); assert.equal((await a.next('done')).kind, 'done');
    const remaining = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id, status: 'running' } });
    const state = await prisma.taskSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(state.activeRunId, remaining.id, 'completion must preserve the other member');
    b.finish(); assert.equal((await b.next('done')).kind, 'done');
    const replay = launch(d1.id); assert.match((await replay.next('error')).error, /already admitted|duplicate|Invalid live room delivery/i);
    console.log('PASS cross-process local Kimi/remote WPI, same-member exclusion, terminal projection, replay');

    const conflictOwner = launch((await delivery(0)).id);
    assert.equal((await conflictOwner.next('started')).kind, 'started');
    const conflict = launch((await delivery(2)).id);
    assert.match((await conflict.next('error')).error, /Workspace write conflict/);
    conflictOwner.finish(); assert.equal((await conflictOwner.next('done')).kind, 'done');
    console.log('PASS same-directory writer conflict before harness execution');

    const readOnly = { profile: 'dev_local', sandboxMode: 'read-only', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [] };
    for (const member of [members[0], members[2], members[3]]) await prisma.liveRoomMember.update({ where: { id: member.id }, data: { acpxPermissionConfig: JSON.stringify(readOnly) } });
    const once = await delivery(0);
    const r1 = launch(once.id), r2 = launch(once.id);
    const verdict = await Promise.all([r1.next('started'), r2.next('started')]);
    assert.equal(verdict.filter(item => item.kind === 'started').length, 1);
    assert.match(verdict.find(item => item.kind === 'error')!.error, /already admitted/);
    const winner = verdict[0].kind === 'started' ? r1 : r2;
    winner.finish(); assert.equal((await winner.next('done')).kind, 'done');
    const sameMessage = launch((await delivery(0, once.roomMessageId)).id);
    assert.match((await sameMessage.next('error')).error, /already admitted/);
    console.log('PASS identical request race and alternate delivery replay');

    const first = launch((await delivery(0)).id), peer = launch((await delivery(3)).id);
    assert.equal((await first.next('started')).kind, 'started');
    assert.equal((await peer.next('started')).kind, 'started');
    first.finish('fail'); assert.match((await first.next('error')).error, /fixture failure/);
    const surviving = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id, status: 'running' } });
    const afterFailure = await prisma.taskSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(afterFailure.activeRunId, surviving.id); assert.equal(afterFailure.status, 'active');
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, 'running');
    peer.finish(); assert.equal((await peer.next('done')).kind, 'done');
    console.log('PASS same harness/display name, different bound members; failure preserves peer');

    // Stored native identities from two member histories collide. Even distinct members cannot resume it twice.
    for (const member of [members[0], members[3]]) {
      const { getLiveRoomParticipantContinuationKey } = await import('../src/lib/live-room-types');
      await prisma.taskRun.create({ data: { taskId: task.id, taskSessionId: session.id, status: 'completed',
        participants: { create: { gatewayId: 'platform-local', gatewayNameSnapshot: 'local', executionBackend: 'platform_local',
          harnessType: 'kimi-code', role: 'custom', agentId: 'kimi-code', status: 'completed',
          controlMetadata: JSON.stringify({ continuationKey: getLiveRoomParticipantContinuationKey(member.id),
            permissionConfig: readOnly, lastSessionId: 'shared-native', lastSessionKind: 'generic_session' }) } } } });
    }
    const nativeOwner = launch((await delivery(0)).id);
    const started = await nativeOwner.next('started'); assert.equal(started.kind, 'started'); assert.equal(started.native, 'shared-native');
    const collision = launch((await delivery(3)).id);
    assert.match((await collision.next('error')).error, /Native session already/);
    nativeOwner.finish(); assert.equal((await nativeOwner.next('done')).kind, 'done');
    console.log('PASS trusted resume binding and native-session exclusion across members');

    const { buildLiveRoomAcpxParticipant } = await import('../src/lib/live-room-members');
    const forged = await delivery(0);
    const request = { taskId: task.id, taskSessionId: session.id, taskName: task.name, workingDirectory: root,
      orchestrationMode: 'single', permissionConfig: readOnly, roomDelivery: { deliveryId: forged.id },
      participants: [buildLiveRoomAcpxParticipant(members[3])] };
    const impersonation = launch(forged.id, request);
    assert.match((await impersonation.next('error')).error, /trusted delivery/);
    request.participants = [{ ...buildLiveRoomAcpxParticipant(members[0]), resumeSessionId: 'invented-native' }];
    const forgedNative = launch(forged.id, request);
    assert.match((await forgedNative.next('error')).error, /Native resume identity/);
    console.log('PASS forged member and unowned native identity rejected');

    const survivor = launch((await delivery(2)).id);
    assert.equal((await survivor.next('started')).kind, 'started');
    const survivorRun = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id, status: 'running' } });
    const orphan = await prisma.taskRun.create({ data: { taskId: task.id, taskSessionId: session.id, status: 'running',
      lastActivityAt: new Date(0), startedAt: new Date(0), controlMetadata: JSON.stringify({ roomAdmission: { memberId: members[0].id } }),
      participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local', harnessType: 'kimi-code',
        role: 'custom', status: 'running', startedAt: new Date(0), lastActivityAt: new Date(0) } } } });
    const { setTaskSessionActiveRun } = await import('../src/lib/acpx/session');
    await setTaskSessionActiveRun(session.id, orphan.id);
    const { reconcileTaskRunLiveness } = await import('../src/lib/acpx/liveness');
    assert.equal(await reconcileTaskRunLiveness(task.id), true);
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: orphan.id } })).status, 'failed');
    assert.equal((await prisma.taskSession.findUniqueOrThrow({ where: { id: session.id } })).activeRunId, survivorRun.id);

    const failedDelivery = await delivery(0);
    const failingRequest = { ...request, roomDelivery: { deliveryId: failedDelivery.id },
      participants: [buildLiveRoomAcpxParticipant(members[0])], fixtureFailOnStart: true };
    assert.match((await launch(failedDelivery.id, failingRequest).next('error')).error, /fixture startup failure/);
    assert.equal((await prisma.taskSession.findUniqueOrThrow({ where: { id: session.id } })).activeRunId, survivorRun.id);
    const failedRun = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id, status: 'failed' }, orderBy: { createdAt: 'desc' } });
    const retryRequest = { ...failingRequest, fixtureFailOnStart: false, roomDelivery: { deliveryId: failedDelivery.id, retryOfRunId: failedRun.id } };
    const retry = launch(failedDelivery.id, retryRequest); assert.equal((await retry.next('started')).kind, 'started');
    retry.finish(); assert.equal((await retry.next('done')).kind, 'done');
    assert.match((await launch(failedDelivery.id, retryRequest).next('error')).error, /already admitted/);
    survivor.finish(); assert.equal((await survivor.next('done')).kind, 'done');
    console.log('PASS liveness cleanup, startup failure, legitimate retry once; surviving member preserved');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => child.once('exit', resolve))));
    await prisma.liveRoom.delete({ where: { id: room.id } }); await prisma.task.delete({ where: { id: task.id } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
