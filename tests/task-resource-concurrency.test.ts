import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';
import { retryResourceApplication } from '../src/lib/task-resources/retry';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import type { AcpxRunRequest } from '../src/lib/acpx/types';
import { requestResourceAccess, decideResourceAccess, getResourceApproval } from '../src/lib/task-resources/access';
import { resourceContinuationLaunch } from '../src/lib/task-resources/runtime';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  process.env.FEISHU_ADMIN_OPEN_ID = 'resource-concurrency-admin';
  const root = await mkdtemp(join(tmpdir(), 'resource-concurrency-'));
  const cwd = join(root, 'workspace'), resource = join(root, 'library'); await mkdir(cwd); await mkdir(resource);
  const adapter = getHarnessAdapter('codex')!, original = { execute: adapter.execute, resume: adapter.resume };
  let invocations = 0;
  const spawnNative = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    invocations++;
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),300)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    const exit = once(child, 'exit'); args.context.onSpawn?.(child);
    await args.context.onSessionStarted?.({ sessionId: 'concurrent-preflight-native', sessionKind: 'codex_thread', threadId: 'concurrent-preflight-native' });
    await exit;
    return { success: true, output: 'preflight continued once', sessionId: 'concurrent-preflight-native', sessionKind: 'codex_thread', threadId: 'concurrent-preflight-native', executionTime: 1 };
  };
  adapter.execute = spawnNative;
  adapter.resume = async () => assert.fail('Source-less preflight must start its sole original native Session');
  try {
    const task = await prisma.task.create({ data: { name: 'concurrent preflight', workingDirectory: cwd } });
    const launch: AcpxRunRequest = { taskId: task.id, taskName: task.name, orchestrationMode: 'single', workingDirectory: cwd,
      participants: [{ gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }],
      permissionConfig: { profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [cwd] } };
    const request = await requestResourceAccess({ launch, requesterOpenId: 'fixture-user', requesterChatId: '', purpose: 'concurrent preflight resource', resources: [{ path: resource, access: 'read' }] });
    assert(request.kind === 'request');
    const approval = await decideResourceAccess({ id: request.approval.id, revision: 1, actorOpenId: 'resource-concurrency-admin', action: 'approve' });
    const launches = await Promise.all([resourceContinuationLaunch(approval), resourceContinuationLaunch(approval)]);
    assert(launches.every(item => !item.taskSessionId), 'Both competing schedulers observed the source-less preflight before session creation');
    const outcomes = await Promise.allSettled(launches.map(item => executeAcpxTaskRun(item)));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
    assert.equal(invocations, 1, 'Approval reservation permits only one native invocation across concurrent schedulers');
    const sessions = await prisma.taskSession.findMany({ where: { taskId: task.id } });
    const runs = await prisma.taskRun.findMany({ where: { taskId: task.id } });
    const updatedTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const updatedApproval = await getResourceApproval(approval.id);
    assert.equal(sessions.length, 1, 'Losing scheduler must not create an orphan Session');
    assert.equal(runs.length, 1);
    assert.equal(updatedTask.currentTaskSessionId, sessions[0].id);
    assert.equal(updatedApproval.payload.launch.taskSessionId, sessions[0].id);
    assert.equal(runs[0].taskSessionId, sessions[0].id);
    assert.equal(updatedApproval.payload.application.runId, runs[0].id);
    assert.equal(runs[0].status, 'completed');
    console.log('Concurrent source-less resource dispatch creates one Session, one TaskRun, one native invocation and one consistent current-session binding');
    const additional = join(root, 'later-resource'); await mkdir(additional);
    const participant = await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: runs[0].id } });
    const later = await requestResourceAccess({ launch: { ...launch, taskSessionId: sessions[0].id }, source: { taskRunId: runs[0].id, participantId: participant.id },
      requesterOpenId: 'fixture-user', requesterChatId: '', purpose: 'later resources', resources: [{ path: additional, access: 'read' }] });
    assert(later.kind === 'request');
    const laterApproval = await decideResourceAccess({ id: later.approval.id, revision: 1, actorOpenId: 'resource-concurrency-admin', action: 'approve' });
    await prisma.taskRun.update({ where: { id: runs[0].id }, data: { controlState: 'stop_requested' } });
    await assert.rejects(resourceContinuationLaunch(laterApproval), /停止|暂停|stop|pause/i);
    assert.equal((await getResourceApproval(laterApproval.id)).status, 'approved', 'Explicit stop preserves the grant without resuming execution');
    await prisma.taskRun.update({ where: { id: runs[0].id }, data: { controlState: 'normal' } });
    await prisma.taskSession.update({ where: { id: sessions[0].id }, data: { status: 'paused' } });
    const pausedLaunch = await resourceContinuationLaunch(laterApproval);
    await assert.rejects(executeAcpxTaskRun(pausedLaunch), /停止|暂停|stop|pause/i);
    assert.equal(await prisma.taskRun.count({ where: { taskId: task.id } }), 1);
    assert.equal(invocations, 1);
    console.log('Source stop and paused TaskSession block automatic resource continuation without revoking grants');
    const retryCwd = join(root, 'retry-workspace'); await mkdir(retryCwd);
    const retryTask = await prisma.task.create({ data: { name: 'retry preflight', workingDirectory: retryCwd } });
    const retryLaunch = { ...launch, taskId: retryTask.id, taskName: retryTask.name, workingDirectory: retryCwd, permissionConfig: { ...launch.permissionConfig!, writableRoots: [retryCwd] } };
    const retryRequest = await requestResourceAccess({ launch: retryLaunch, requesterOpenId: 'fixture-user', requesterChatId: '', purpose: 'retry preflight', resources: [{ path: resource, access: 'read' }] });
    assert(retryRequest.kind === 'request');
    const retryApproval = await decideResourceAccess({ id: retryRequest.approval.id, revision: 1, actorOpenId: 'resource-concurrency-admin', action: 'approve' });
    adapter.execute = async args => ({ ...await spawnNative(args), success: false, error: 'fixture failure after native session started' });
    assert.equal((await executeAcpxTaskRun(await resourceContinuationLaunch(retryApproval))).status, 'failed');
    const failedApproval = await getResourceApproval(retryApproval.id);
    assert(failedApproval.payload.application.runId);
    // Reconciliation persists the failed application outcome after the native runner returns.
    const { reconcileResourceApprovals, drainResourceApprovals } = await import('../src/lib/task-resources/reconcile');
    const cards = require('../src/lib/task-resources/cards'), publish = cards.publishResourceApproval;
    cards.publishResourceApproval = async () => {};
    try { await reconcileResourceApprovals(retryApproval.id); await drainResourceApprovals(); }
    finally { cards.publishResourceApproval = publish; }
    const reset = await retryResourceApplication(retryApproval.id, 1, 'resource-concurrency-admin');
    assert.equal(reset.payload.source?.taskRunId, failedApproval.payload.application.runId);
    adapter.execute = async () => assert.fail('Retry after preflight native startup must resume, not create another native Session');
    adapter.resume = async args => { assert.equal(args.sessionId, 'concurrent-preflight-native'); return spawnNative(args); };
    assert.equal((await executeAcpxTaskRun(await resourceContinuationLaunch(reset))).status, 'completed');
    assert.equal(await prisma.taskSession.count({ where: { taskId: retryTask.id } }), 1);
    console.log('Preflight retry adopts its exited failed run and resumes the recorded native Session');


  } finally { adapter.execute = original.execute; adapter.resume = original.resume; await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
