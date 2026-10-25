import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { setGraphRunPaused } from '../src/lib/task-graph/run-control';
import { getHarnessAdapter } from '../src/lib/harness';
import { decideResourceAccess, getResourceApproval, updateResourceApplication } from '../src/lib/task-resources/access';
import { retryResourceApplication } from '../src/lib/task-resources/retry';
import { drainResourceApprovals, reconcileResourceApprovals } from '../src/lib/task-resources/reconcile';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'resource-graph-'));
  const repository = path.join(root, 'repo'), extra = path.join(root, 'reader');
  mkdirSync(repository); mkdirSync(extra);
  writeFileSync(path.join(extra, 'sample.txt'), 'approved sample');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  writeFileSync(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  process.env.FEISHU_ADMIN_OPEN_ID = 'resource-admin';
  process.env.FEISHU_APP_ID = `resource-app-${Date.now()}`;
  const require = createRequire(__filename);
  const cards = require('../src/lib/task-resources/cards');
  const feishu = require('../src/lib/task-graph/feishu');
  const api = require('../src/lib/feishu-api');
  const entry = require('../src/lib/feishu-task-entry-api');
  const originalApi = { send: api.sendFeishuInteractiveMessage, thread: entry.getFeishuTaskThread, update: entry.updateFeishuTaskEntryCard };
  api.sendFeishuInteractiveMessage = async (args: { uuid: string }) => `message-${args.uuid}`;
  entry.getFeishuTaskThread = async (args: { requestId: string }) => `thread-${args.requestId}`;
  entry.updateFeishuTaskEntryCard = async () => {};
  const originalCard = cards.publishResourceApproval;
  const originalParent = feishu.postGraphParentProgress, originalChild = feishu.postGraphChildProgress;
  const published: string[] = [];
  cards.publishResourceApproval = async (id: string) => { published.push(id); };
  feishu.postGraphParentProgress = async () => {};
  feishu.postGraphChildProgress = async () => {};

  const adapter = getHarnessAdapter('codex')!;
  const original = { execute: adapter.execute, resume: adapter.resume };
  const nativeSession = 'native-resource-graph';
  const reviewerSession = 'native-resource-reviewer';
  const calls: { kind: 'execute' | 'resume'; task: string; cwd: string; session?: string; read: string[] }[] = [];
  const reviewCalls: { kind: 'execute' | 'resume'; cwd: string; session?: string }[] = [];
  let firstCwd = '', firstReviewCwd = '', reviewCandidate = '';
  const run = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child);
    await once(child, 'exit');
    const resume = 'sessionId' in args;
    const review = args.task.id.startsWith('task-graph-review-');
    const session = review ? reviewerSession : nativeSession;
    await args.context.onSessionStarted?.({ sessionId: session, sessionKind: 'codex_thread', threadId: session });
    if (review) {
      reviewCalls.push({ kind: resume ? 'resume' : 'execute', cwd: args.context.workingDirectory, session: resume ? args.sessionId : undefined });
      const candidate = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { key: 'A' } } });
      if (!resume) {
        reviewCandidate = candidate.commit!;
        firstReviewCwd = args.context.workingDirectory;
        return { success: true, output: `<resource-request>${JSON.stringify({ purpose: 'Verify the fixed candidate against the sibling sample',
          resources: [{ path: extra, access: 'read' }] })}</resource-request>`,
          sessionId: reviewerSession, sessionKind: 'codex_thread', executionTime: 1 };
      }
      assert.equal(args.sessionId, reviewerSession, 'The tester must resume its original native Session');
      assert.equal(args.context.workingDirectory, firstReviewCwd, 'The tester must keep its original review cwd');
      assert.equal(candidate.commit, reviewCandidate, 'The reviewer must see the same fixed candidate');
      assert.ok(args.context.extraReadOnlyPaths?.includes(extra), 'Tester must receive only its approved extra readonly directory');
      return { success: true, output: 'TASK_GRAPH_REVIEW {"approved":true,"note":"fixed candidate verified with approved sample"}',
        sessionId: reviewerSession, sessionKind: 'codex_thread', executionTime: 1 };
    }
    calls.push({ kind: resume ? 'resume' : 'execute', task: args.task.name,
      cwd: args.context.workingDirectory, session: resume ? args.sessionId : undefined,
      read: args.context.extraReadOnlyPaths || [] });
    if (args.task.name.startsWith('A')) {
      if (!resume) {
        firstCwd = args.context.workingDirectory;
        assert.match(args.task.description || '', /<resource-request>/, 'Actual graph stage must expose the approval card protocol');
        return { success: true, output: `<resource-request>${JSON.stringify({ purpose: 'Read a sibling repository fixture',
          resources: [{ path: extra, access: 'write' }] })}</resource-request>`,
          sessionId: nativeSession, sessionKind: 'codex_thread', executionTime: 1 };
      }
      const existing = await prisma.feishuAdminApproval.findMany({ where: { kind: 'task_resources' }, select: { id: true, status: true } });
      assert.ok(existing.some(row => row.status === 'approved'), 'Resource graph resumed before approval: ' + JSON.stringify({ existing,
        runs: await prisma.taskRun.findMany({ orderBy: { startedAt: 'desc' }, take: 3, select: { status: true, summary: true, error: true } }) }));
      assert.equal(args.sessionId, nativeSession, 'Resource continuation must use the original native Session');
      assert.equal(args.context.workingDirectory, firstCwd, 'Resource continuation must preserve the worktree cwd');
      assert.ok(args.context.extraWritableRoots?.includes(extra), 'Approved sibling write directory must reach the actual harness context');
      writeFileSync(path.join(args.context.workingDirectory, 'delivered.txt'), readFileSync(path.join(extra, 'sample.txt')));
      return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"read approved sample","evidence":["delivered.txt"]}',
        sessionId: nativeSession, sessionKind: 'codex_thread', executionTime: 1 };
    }
    writeFileSync(path.join(args.context.workingDirectory, 'next.txt'), 'next');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"dependent task ran","evidence":["next.txt"]}',
      sessionId: nativeSession, sessionKind: 'codex_thread', executionTime: 1 };
  };
  const phasedRun = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const result = await run(args);
    if (result.output.startsWith('<resource-request>')) {
      await args.context.streamCallbacks?.onStdoutChunk?.('发现额外目录需求', { id: 'progress', phase: 'commentary' });
      await args.context.streamCallbacks?.onStdoutChunk?.(result.output, { id: 'final', phase: 'final_answer', operation: 'replace' });
      return { ...result, output: '发现额外目录需求\n\n' + result.output };
    }
    return result;
  };
  adapter.execute = phasedRun;
  adapter.resume = phasedRun;

  const owner = await prisma.user.create({ data: { username: `resource-${Date.now()}`, passwordHash: 'fixture', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'resource graph', ownerUserId: owner.id } });
  const room = await prisma.liveRoom.create({ data: { title: 'Resource repository', workingDirectory: repository } });
  await prisma.feishuConversationBinding.create({ data: { scopeKey: `resource-group-${parent.id}`, appId: process.env.FEISHU_APP_ID,
    chatId: 'resource-group', chatType: 'group', liveRoomId: room.id } });
  await prisma.feishuGroupTaskSettings.create({ data: { appId: process.env.FEISHU_APP_ID!, chatId: 'resource-group', isolationEnabled: true } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id,
    definition: { specRef: 'fixture://resource-graph', nodes: ['A', 'NEXT'].map(key => ({ key, goal: key,
      dependsOn: key === 'NEXT' ? ['A'] : [], executionMode: 'lean', acceptance: key === 'A'
        ? { mode: 'agent', reviewerId: 'local:codex', checks: ['delivered'], reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } }
        : { mode: 'automatic', checks: ['next'] },
      executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'),
        agentSelector: 'local:codex', instructions: key, launchConfig: { participant, checks: [{ name: key === 'A' ? 'delivered' : 'next', argv: ['node', '-e', `require('fs').accessSync('${key === 'A' ? 'delivered.txt' : 'next.txt'}')`] }] } }] })) } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: graph.id, key: 'A' } } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
  const approvalIds: string[] = [];
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); await drainResourceApprovals(); };
  const until = async (condition: () => Promise<boolean>) => {
    for (let n = 0; n < 80; n++) {
      await runTaskGraphCycle(); await drain();
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Resource graph did not reach expected state: ' + JSON.stringify({
      node: (await prisma.taskGraphNode.findUnique({ where: { id: node.id } }))?.status,
      execution: executionProgress((await prisma.taskGraphExecution.findUnique({ where: { id: job.id } }))?.dispatchMetadata),
      approvals: (await prisma.feishuAdminApproval.findMany({ where: { kind: 'task_resources' } })).map(row => ({ status: row.status, application: JSON.parse(row.payloadJson || '{}').application })),
      runs: (await prisma.taskRun.findMany({ where: { taskId: job.childTaskId || '' }, orderBy: { startedAt: 'desc' }, take: 4 })).map(run => ({ status: run.status, summary: run.summary })),
      events: (await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'desc' }, take: 15 })).map(event => ({ kind: event.kind, detail: (event.payload as any)?.outcome?.failure?.detail || (event.payload as any)?.detail })),
    }));
  };
  try {
    await until(async () => (await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status === 'attention');
    const blocked = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(executionProgress(blocked.dispatchMetadata)?.lastFailure?.code, 'permission_required', JSON.stringify({
      progress: executionProgress(blocked.dispatchMetadata), calls, events: await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
    }));
    assert.equal(calls.filter(call => call.task.startsWith('A')).length, 1);
    assert.equal(await prisma.taskGraphNode.count({ where: { runId: graph.id, key: 'NEXT', status: 'planned' } }), 1);
    const approvalRow = await prisma.feishuAdminApproval.findFirstOrThrow({ where: { kind: 'task_resources', payloadJson: { contains: job.id } } });
    approvalIds.push(approvalRow.id);
    const approval = await getResourceApproval(approvalRow.id);
    assert.equal(approval.payload.source?.taskRunId, blocked.taskRunId);
    assert.equal(approval.requesterChatId, '', 'Unbound child request uses the admin fallback without inventing a task topic');
    assert.deepEqual(approval.payload.resources.map(resource => [resource.canonicalPath, resource.access]), [[extra, 'write']]);
    assert.ok(published.includes(approval.id), 'The original request must publish one reviewable card intent');
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: approval.payload.source!.taskRunId } })).status, 'completed');
    // An old coordinator saved the same permission request as a user question.
    // Restoring its pending card must not require rewriting that execution outcome.
    const legacyProgress = { ...executionProgress(blocked.dispatchMetadata)!, state: 'waiting_for_user' as const,
      waitingKind: 'question' as const, waitingMessage: 'permission_required: edit sibling repository', lastFailure: undefined };
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: { progress: legacyProgress } } });
    await decideResourceAccess({ id: approval.id, revision: approval.payload.revision, actorOpenId: 'resource-admin', action: 'approve' });
    const upstream = require('../src/lib/task-graph/upstream-inputs');
    const prepareUpstream = upstream.prepareUpstreamInputs;
    upstream.prepareUpstreamInputs = async () => { throw new Error('fixture upstream capacity exceeded'); };
    try { await reconcileResourceApprovals(approval.id); await drainResourceApprovals(); }
    finally { upstream.prepareUpstreamInputs = prepareUpstream; }
    assert.equal((await getResourceApproval(approval.id)).payload.application.state, 'waiting');
    await reconcileResourceApprovals(approval.id); await drainResourceApprovals();
    assert.match((await getResourceApproval(approval.id)).payload.application.detail || '', /fixture upstream capacity exceeded/, 'Backoff must preserve the actual preparation failure');
    assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.lastFailure?.code, 'environment_failed');
    const { validateResourceAdmission } = require('../src/lib/task-resources/graph-admission');
    await validateResourceAdmission(approval.id, node.id, [job.id]);
    const deferred = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const deferredProgress = executionProgress(deferred.dispatchMetadata)!;
    for (const changed of [
      { ...deferredProgress, revision: deferredProgress.revision + 1 },
      { ...deferredProgress, lastFailure: { ...deferredProgress.lastFailure!, detail: 'unrelated environment failure' } },
      { ...deferredProgress, taskRunId: 'another-source-run' },
    ]) {
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: JSON.parse(JSON.stringify({ progress: changed })) } });
      await assert.rejects(validateResourceAdmission(approval.id, node.id, [job.id]), /执行归属或阻塞原因已改变/);
    }
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: deferred.dispatchMetadata!, claimToken: 'another-owner' } });
    await assert.rejects(validateResourceAdmission(approval.id, node.id, [job.id]), /执行归属或阻塞原因已改变/);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: deferred.claimToken } });
    await updateResourceApplication(approval.id, { state: 'failed', detail: '资源申请的执行归属或阻塞原因已改变' });
    await retryResourceApplication(approval.id, approval.payload.revision, 'resource-admin');
    assert.equal((await getResourceApproval(approval.id)).status, 'approved', 'Preparation retry reuses the existing authorization');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await reconcileResourceApprovals(approval.id); await drainResourceApprovals();
    await until(async () => (await prisma.feishuAdminApproval.count({ where: { kind: 'task_resources', status: 'pending', payloadJson: { contains: node.id } } })) === 1 && reviewCalls.length === 1);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.worktreePath, blocked.worktreePath);
    assert.deepEqual(calls.filter(call => call.task.startsWith('A')).map(call => [call.kind, call.session, call.cwd]), [
      ['execute', undefined, firstCwd], ['resume', nativeSession, firstCwd],
    ]);
    assert.equal(readFileSync(path.join(firstCwd, 'delivered.txt'), 'utf8'), 'approved sample');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_admitted', payload: { path: ['source'], equals: 'resource_approval' } } }), 1);
    const applied = await getResourceApproval(approval.id);
    assert.equal(applied.payload.application.state, 'effective');
    assert.ok(applied.payload.application.runId);
    assert.ok(after.commit, 'Implementation candidate must be fixed before reviewer asks for access');
    assert.equal(after.commit, reviewCandidate);
    assert.equal(await prisma.taskGraphNode.count({ where: { runId: graph.id, key: 'NEXT', status: 'planned' } }), 1);

    const reviewRow = await prisma.feishuAdminApproval.findFirstOrThrow({ where: { kind: 'task_resources', status: 'pending', payloadJson: { contains: node.id } } });
    approvalIds.push(reviewRow.id);
    const reviewApproval = await getResourceApproval(reviewRow.id);
    assert.equal(reviewApproval.payload.launch.graphReview?.nodeId, node.id);
    assert.equal(reviewApproval.payload.launch.participants[0].role, 'tester');
    assert.equal(reviewApproval.payload.source?.taskRunId,
      (await prisma.taskRun.findFirstOrThrow({ where: { taskId: `task-graph-review-${node.id}` } })).id);
    await setGraphRunPaused({ runId: graph.id, paused: true, requestId: 'resource-review-pause', actorId: owner.id, reason: 'user paused review' });
    await decideResourceAccess({ id: reviewApproval.id, revision: reviewApproval.payload.revision, actorOpenId: 'resource-admin', action: 'approve' });
    await reconcileResourceApprovals(reviewApproval.id); await drainResourceApprovals();
    for (let i = 0; i < 3; i++) { await runTaskGraphCycle(); await drain(); }
    assert.equal(reviewCalls.length, 1, 'Approval cannot dispatch the tester while the user pause is active');
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: graph.id } })).status, 'paused');
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).commit, reviewCandidate);
    await setGraphRunPaused({ runId: graph.id, paused: false, requestId: 'resource-review-unpause', actorId: owner.id, reason: 'user resumed review' });
    await reconcileResourceApprovals(reviewApproval.id); await drainResourceApprovals();
    await until(async () => (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status === 'passed');
    assert.deepEqual(reviewCalls.map(call => [call.kind, call.session, call.cwd]), [
      ['execute', undefined, firstReviewCwd], ['resume', reviewerSession, firstReviewCwd],
    ]);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).commit, reviewCandidate);
    assert.equal(calls.filter(call => call.task.startsWith('A')).length, 2, 'Review resource approval must not replay implementation');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_admitted', payload: { path: ['source'], equals: 'resource_approval' } } }), 2);
    await until(async () => (await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: graph.id } })).status === 'completed');
    assert.equal(calls.filter(call => call.task.startsWith('NEXT')).length, 1);
    console.log('Graph implementation and tester resource requests resume their own native Sessions and fixed candidate; user pause gates tester dispatch');
  } finally {
    await drain();
    adapter.execute = original.execute; adapter.resume = original.resume;
    cards.publishResourceApproval = originalCard;
    feishu.postGraphParentProgress = originalParent; feishu.postGraphChildProgress = originalChild;
    api.sendFeishuInteractiveMessage = originalApi.send; entry.getFeishuTaskThread = originalApi.thread; entry.updateFeishuTaskEntryCard = originalApi.update;
    for (const id of approvalIds) await prisma.feishuAdminApproval.delete({ where: { id } });
    await prisma.taskGraphRun.delete({ where: { id: graph.id } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
