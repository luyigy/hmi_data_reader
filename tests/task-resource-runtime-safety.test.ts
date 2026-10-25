import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import type { HarnessExecuteArgs, HarnessResumeArgs, HarnessExecuteResult } from '../src/lib/harness/types';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import type { AcpxRunRequest } from '../src/lib/acpx/types';
import { requestResourceAccess, decideResourceAccess, getResourceApproval } from '../src/lib/task-resources/access';
import { reconcileResourceApprovals, drainResourceApprovals } from '../src/lib/task-resources/reconcile';
import { retryResourceApplication } from '../src/lib/task-resources/retry';
import { getContinuationSession } from '../src/lib/acpx/session-tracking';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  process.env.FEISHU_ADMIN_OPEN_ID = 'resource-safety-admin';
  const root = await mkdtemp(join(tmpdir(), 'resource-runtime-safety-'));
  const cards = require('../src/lib/task-resources/cards'), originalPublish = cards.publishResourceApproval;
  cards.publishResourceApproval = async () => {};
  const adapter = getHarnessAdapter('codex')!, original = { execute: adapter.execute, resume: adapter.resume };
  let implementation: (args: HarnessExecuteArgs | HarnessResumeArgs) => Promise<HarnessExecuteResult>;
  adapter.execute = args => implementation(args); adapter.resume = args => implementation(args);
  const decide = (id: string, action: 'approve' | 'revoke') => decideResourceAccess({ id, revision: 1, actorOpenId: 'resource-safety-admin', action });
  const fixture = async (name: string) => {
    const cwd = join(root, name), resource = join(root, `${name}-resource`);
    await mkdir(cwd); await mkdir(resource);
    const task = await prisma.task.create({ data: { name, workingDirectory: cwd } });
    const launch: AcpxRunRequest = { taskId: task.id, taskName: name, orchestrationMode: 'single', workingDirectory: cwd,
      participants: [{ gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }],
      permissionConfig: { profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [cwd] } };
    const request = async (source?: { taskRunId: string; participantId: string }) => {
      const result = await requestResourceAccess({ launch, source, requesterOpenId: 'fixture-user', requesterChatId: 'fixture-chat', purpose: name, resources: [{ path: resource, access: 'read' }] });
      assert(result.kind === 'request'); return result.approval.id;
    };
    return { task, cwd, resource, launch, request };
  };
  const nativeResult = (sessionId = 'original-native') => ({ success: true, output: 'fixture complete', sessionId, sessionKind: 'codex_thread', threadId: sessionId, executionTime: 1 });
  const runChild = async (args: HarnessExecuteArgs | HarnessResumeArgs, sessionId = 'original-native') => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),300)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    const exit = once(child, 'exit'); args.context.onSpawn?.(child);
    try { await args.context.onSessionStarted?.({ sessionId, sessionKind: 'codex_thread', threadId: sessionId }); }
    catch (error) { child.kill('SIGKILL'); await exit; throw error; }
    await exit; return nativeResult(sessionId);
  };
  try {
    const preflight = await fixture('preflight');
    const hidden = join(root, 'unapproved-target'); await mkdir(hidden); await writeFile(join(hidden, 'secret'), 'secret');
    await symlink(hidden, join(preflight.resource, 'outside'));
    let turns = 0;
    implementation = async args => {
      turns++;
      assert.equal(args.context.taskEnvironment?.AP_RESOURCE_SCOPE, '1');
      const script = `const fs=require('fs'),a=require('assert/strict');a.equal(fs.existsSync(${JSON.stringify(join(preflight.resource, 'outside', 'secret'))}),false);a.equal(fs.existsSync(${JSON.stringify(hidden)}),false);setTimeout(()=>process.exit(0),300)`;
      const plan = prepareSandboxEnvironment({ command: process.execPath, commandArgs: ['-e', script], cwd: preflight.cwd, workspaceRoot: preflight.cwd,
        readOnlyPaths: args.context.extraReadOnlyPaths, writableRoots: args.context.extraWritableRoots, env: { ...process.env, ...args.context.taskEnvironment }, networkAccess: 'restricted' });
      const command = renderBubblewrap(plan), child = spawn(command.command, command.args, { cwd: preflight.cwd, env: plan.env, stdio: 'pipe' });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); const exit = once(child, 'exit'); args.context.onSpawn?.(child);
      await args.context.onSessionStarted?.({ sessionId: 'preflight-native', sessionKind: 'codex_thread', threadId: 'preflight-native' });
      assert.equal((await exit)[0], 0, stderr); return nativeResult('preflight-native');
    };
    const preflightId = await preflight.request(); await decide(preflightId, 'approve');
    await reconcileResourceApprovals(preflightId); await drainResourceApprovals();
    let approval = await getResourceApproval(preflightId);
    assert.equal(approval.payload.application.state, 'effective', JSON.stringify(approval.payload.application));
    assert(approval.payload.launch.taskSessionId, 'Preflight request binds its newly created TaskSession');
    await reconcileResourceApprovals(preflightId); await drainResourceApprovals(); assert.equal(turns, 1);
    console.log('Preflight without source/session starts once; symlink targets stay outside actual resource sandbox');
    await prisma.taskRun.update({ where: { id: approval.payload.application.runId! }, data: { status: 'running', completedAt: null } });
    await reconcileResourceApprovals(preflightId); await drainResourceApprovals();
    const recovered = await getResourceApproval(preflightId);
    assert.equal(recovered.payload.application.state, 'failed');
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: approval.payload.application.runId! } })).status, 'interrupted');
    assert.equal(turns, 1, 'Crash recovery must not replay native operations automatically');
    console.log('Exited reserved run is recoverable after restart without automatic replay');

    const mismatch = await fixture('native-mismatch');
    implementation = args => runChild(args);
    assert.equal((await executeAcpxTaskRun(mismatch.launch)).status, 'completed');
    const first = await prisma.taskRun.findFirstOrThrow({ where: { taskId: mismatch.task.id }, include: { participants: true } });
    mismatch.launch.taskSessionId = first.taskSessionId!;
    const mismatchId = await mismatch.request({ taskRunId: first.id, participantId: first.participants[0].id });
    await decide(mismatchId, 'approve');
    implementation = args => runChild(args, 'wrong-native');
    await reconcileResourceApprovals(mismatchId); await drainResourceApprovals();
    approval = await getResourceApproval(mismatchId);
    assert.equal(approval.payload.application.state, 'failed');
    const second = await prisma.taskRun.findUniqueOrThrow({ where: { id: approval.payload.application.runId! }, include: { participants: true } });
    assert.equal(second.status, 'failed');
    assert.notEqual(getContinuationSession(second.participants[0]).sessionId, 'wrong-native');
    assert.equal(getContinuationSession((await prisma.taskRunParticipant.findUniqueOrThrow({ where: { id: first.participants[0].id } }))).sessionId, 'original-native');
    console.log('Native Session mismatch fails before participant session metadata can be rebound');
    implementation = args => runChild(args);
    await Promise.all([retryResourceApplication(mismatchId, 1, 'resource-safety-admin'), retryResourceApplication(mismatchId, 1, 'resource-safety-admin')]);
    await Promise.all([reconcileResourceApprovals(mismatchId), reconcileResourceApprovals(mismatchId)]); await drainResourceApprovals();
    approval = await getResourceApproval(mismatchId);
    assert.equal(approval.payload.application.state, 'effective', JSON.stringify(approval.payload.application));
    assert.equal(await prisma.taskRun.count({ where: { taskId: mismatch.task.id } }), 3);
    assert.equal(approval.payload.decisions?.filter(decision => decision.action === 'approve').length, 1);
    console.log('Failed startup retries once using the same grant and original Session without another approval');

    const revoked = await fixture('revoked-start'); const revokedId = await revoked.request(); await decide(revokedId, 'approve');
    let callbackRejected = false;
    implementation = async args => {
      await decide(revokedId, 'revoke');
      try { await args.context.onSessionStarted?.({ sessionId: 'must-not-bind', sessionKind: 'codex_thread', threadId: 'must-not-bind' }); }
      catch (error) { callbackRejected = true; throw error; }
      assert.fail('Revoked inherited grant allowed native startup');
    };
    assert.equal((await executeAcpxTaskRun(revoked.launch)).status, 'failed'); assert(callbackRejected);
    const revokedRun = await prisma.taskRun.findFirstOrThrow({ where: { taskId: revoked.task.id }, include: { participants: true } });
    assert.notEqual(getContinuationSession(revokedRun.participants[0]).sessionId, 'must-not-bind');
    console.log('Inherited grant revoked during startup cannot bind a native Session');

    const running = await fixture('revoked-running'); const runningId = await running.request(); await decide(runningId, 'approve');
    let signal: string | null = null;
    implementation = async args => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
      const exit = once(child, 'exit'); args.context.onSpawn?.(child);
      await args.context.onSessionStarted?.({ sessionId: 'running-native', sessionKind: 'codex_thread', threadId: 'running-native' });
      // This database-only decision deliberately skips the reconciler's in-process stop request.
      await decide(runningId, 'revoke');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const [code, received] = await exit; signal = received; assert.equal(code, null); }
      finally { clearTimeout(timeout); }
      return nativeResult('running-native');
    };
    const began = Date.now(); const runningResult = await executeAcpxTaskRun(running.launch);
    assert.equal(runningResult.status, 'stopped'); assert(signal); assert(Date.now() - began < 4500, 'Database watcher must stop before emergency cleanup');
    console.log('Database revocation watcher stops a real process without a reconciler stop signal');

    const legacy = await fixture('legacy-no-proof');
    const session = await prisma.taskSession.create({ data: { taskId: legacy.task.id, summary: 'legacy' } });
    await prisma.task.update({ where: { id: legacy.task.id }, data: { currentTaskSessionId: session.id } });
    legacy.launch.taskSessionId = session.id;
    const legacyRun = await prisma.taskRun.create({ data: { taskId: legacy.task.id, taskSessionId: session.id, status: 'completed', participants: { create: {
      executionBackend: 'platform_local', gatewayId: 'platform-local', gatewayNameSnapshot: 'local', harnessType: 'codex', role: 'implementer', status: 'completed',
      controlMetadata: JSON.stringify({ lastSessionId: 'legacy-native', lastSessionKind: 'codex_thread' }) } } }, include: { participants: true } });
    const legacyId = await legacy.request({ taskRunId: legacyRun.id, participantId: legacyRun.participants[0].id }); await decide(legacyId, 'approve');
    implementation = async () => assert.fail('Legacy status without exit proof must never launch');
    await reconcileResourceApprovals(legacyId); await drainResourceApprovals();
    assert.equal(await prisma.taskRun.count({ where: { taskId: legacy.task.id } }), 1);
    assert.equal((await getResourceApproval(legacyId)).payload.application.runId, undefined);
    console.log('Legacy completed status without durable process exit proof cannot continue');
  } finally {
    await drainResourceApprovals(); adapter.execute = original.execute; adapter.resume = original.resume; cards.publishResourceApproval = originalPublish;
    await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
