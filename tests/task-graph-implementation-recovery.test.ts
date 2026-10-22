import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { parseImplementationResult, graphRecoveryKind } from '../src/lib/task-graph/implementation-result';
import { requestGraphConversationRecovery, startConversationRecoveries } from '../src/lib/task-graph/conversation-recovery';
import { recoverTaskGraphNode, runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { cleanupFinishedWorkspaces } from '../src/lib/task-graph/completed-workspaces';
import { ensureJobWorktree } from '../src/lib/task-graph/worktree';
import { handleGraphConversationIntent, applyGraphControlOutput } from '../src/lib/task-graph/conversation-intent';

async function main() {
  for (const output of ['', 'Only a blocked report', 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":[]}',
    'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing","blockerKind":"guess"}',
    'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["file"]}\nTASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing","blockerKind":"environment_failed"}']) {
    assert.throws(() => parseImplementationResult(output));
  }
  assert.equal(parseImplementationResult('Readable report\nTASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["file"]}').status, 'delivered');
  const root = mkdtempSync(path.join(tmpdir(), 'implementation-recovery-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'baseline'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  const originalAdmin = process.env.FEISHU_ADMIN_OPEN_ID;
  process.env.FEISHU_ADMIN_OPEN_ID = 'fixture-admin';
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  const require = createRequire(__filename);
  const feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null;
  const notices: string[] = [];
  feishu.postGraphParentProgress = async (_id: string, _run: string, text: string) => { notices.push(text); };
  feishu.postGraphChildProgress = async (_id: string, _run: string, text: string) => { notices.push(text); };
  const acknowledgements: string[] = [];
  require('../src/lib/feishu-api').replyFeishuMessage = async (args: { content: { text: string } }) => { acknowledgements.push(args.content.text); return 'ack'; };
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  require('../src/lib/feishu-task-entry-api').isFeishuGroupAdmin = async () => false;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture', expire: 3600, data: { message_id: 'fixture-message' } }));
  let calls = 0;
  const adapter = getHarnessAdapter('codex'); assert.ok(adapter);
  adapter.execute = async ({ task, context }) => {
    calls++;
    assert.match(task.description || '', /TASK_GRAPH_IMPLEMENTATION/);
    const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId: task.id }, include: { node: true } });
    if (job.node.key === 'A') {
      writeFileSync(path.join(context.workingDirectory!, 'saved.txt'), 'progress ' + calls);
      if (calls === 1) return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"waiting_for_user","note":"need source photo"}', executionTime: 1 };
      assert.match(task.description || '', /NEW-MATERIAL/);
      if (calls === 3) {
        assert.equal(readFileSync(path.join(context.workingDirectory!, 'baseline'), 'utf8'), 'approved correction during pause');
        assert.equal(readFileSync(path.join(context.workingDirectory!, 'supplement.txt'), 'utf8'), 'new material');
      }
      if (calls === 2) {
        writeFileSync(path.join(context.workingDirectory!, 'baseline'), 'approved correction during pause');
        writeFileSync(path.join(context.workingDirectory!, 'supplement.txt'), 'new material');
        return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {broken result', executionTime: 1 };
      }
    }
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implementation finished","evidence":["saved.txt"]}', executionTime: 1 };
  };
  const parent = await prisma.task.create({ data: { name: 'generic recovery' } });
  const room = await prisma.liveRoom.create({ data: { title: 'recovery', sourceTaskId: parent.id } });
  await prisma.feishuConversationBinding.create({ data: { liveRoomId: room.id, chatId: 'fixture-chat', appId: 'fixture', scopeKey: parent.id, chatType: 'p2p' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://recovery', nodes: ['A', 'B'].map(key => ({
    key, goal: key, dependsOn: key === 'B' ? ['A'] : [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
    executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: baseline, agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant, checks: [] } }],
  })) } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } } });
  async function until(predicate: () => Promise<boolean>) {
    for (let i = 0; i < 300; i++) { await runTaskGraphCycle(); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Recovery fixture timed out ' + JSON.stringify({ calls, notices, nodes: await prisma.taskGraphNode.findMany({where:{runId:run.id},include:{executions:true}}), events: await prisma.taskGraphEvent.findMany({where:{runId:run.id},orderBy:{createdAt:'desc'},take:8}) }));
  }
  async function drain() { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); }
  const request = { roomId: room.id, chatId: 'fixture-chat', openId: 'fixture-admin', messageId: 'continue-first', nodeKey: 'A', text: 'A 继续' };
  try {
    await until(async () => (await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } })).status === 'attention');
    await drain();
    const legacy = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    const legacyProgress = executionProgress(legacy.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: legacy.id }, data: { issueKind: 'missing_business_material', dispatchMetadata: metadataWithProgress(legacy.dispatchMetadata, { ...legacyProgress, state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: 'need source photo' } }) } });
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, kind: 'implementation_blocked', idempotencyKey: 'fixture:historical-material-pause', payload: { executionId: legacy.id, taskRunId: legacy.taskRunId } } });
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status, 'attention');
    assert.equal(await graphRecoveryKind(node.id), 'implementation');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'execution_integrated' } }), 0);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'B' } } })).status, 'planned');
    const first = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    assert.ok(first.worktreePath && first.worktreeBranch && first.taskRunId);
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: first.taskRunId } })).status, 'completed', 'Completed Harness must not complete a blocked node');
    const checkpoint = git('rev-parse', first.worktreeBranch);
    const integrationRef = git('for-each-ref', '--format=%(refname)', 'refs/heads/task-graph/integration/');
    assert.equal(git('rev-parse', integrationRef), baseline, 'Blocked progress must stay out of integration');
    writeFileSync(path.join(first.worktreePath, 'baseline'), 'pause-time spec correction');
    writeFileSync(path.join(first.worktreePath, 'dirty.txt'), 'preserve');
    const resumedDirty = await ensureJobWorktree({ repoPath: repository, runId: run.id, jobId: first.id, baseRef: integrationRef, baseCommit: baseline, resumeCommit: checkpoint });
    assert.equal(resumedDirty.path, first.worktreePath);
    assert.equal(readFileSync(path.join(first.worktreePath, 'dirty.txt'), 'utf8'), 'preserve', 'Resume preserves pause-time supplementary files');
    assert.equal(readFileSync(path.join(first.worktreePath, 'baseline'), 'utf8'), 'pause-time spec correction');
    assert.equal(git('-C', first.worktreePath, 'rev-parse', 'HEAD'), checkpoint);
    writeFileSync(path.join(first.worktreePath, 'baseline'), 'base');
    rmSync(path.join(first.worktreePath, 'dirty.txt'));
    await assert.rejects(ensureJobWorktree({ repoPath: repository, runId: run.id, jobId: first.id, baseRef: integrationRef, baseCommit: baseline, resumeCommit: baseline }), /Checkpoint branch moved/);
    git('worktree', 'remove', first.worktreePath);
    assert.equal(git('rev-parse', first.worktreeBranch), checkpoint, 'Unintegrated checkpoint branch remains protected');
    await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'NEW-MATERIAL 用这张图继续' } });
    await assert.rejects(requestGraphConversationRecovery({ ...request, openId: 'stranger' }), /管理员/);
    const event = await requestGraphConversationRecovery(request);
    assert.equal((await requestGraphConversationRecovery(request)).id, event.id);
    const control = await applyGraphControlOutput({ roomId: room.id, sourceContent: 'A 继续',
      sourceMetadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'fixture-admin', feishuChatId: 'fixture-chat', feishuMessageId: request.messageId }),
      output: '<graph-control>{"action":"resume_task","nodeKey":"A"}</graph-control>' });
    assert.doesNotMatch(control, /graph-control/);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'conversation_review_recovery_requested' } }), 1);
    const ownerBefore = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.id } });
    const proofBefore = executionProgress(ownerBefore.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: first.id }, data: { dispatchMetadata: metadataWithProgress(ownerBefore.dispatchMetadata, { ...proofBefore, workerReleasedAt: undefined }) } });
    assert.deepEqual(await startConversationRecoveries(recoverTaskGraphNode), [], 'An active writer defers the existing request instead of consuming it');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'conversation_review_recovery_started' } }), 0);
    await prisma.taskGraphExecution.update({ where: { id: first.id }, data: { dispatchMetadata: metadataWithProgress(ownerBefore.dispatchMetadata, proofBefore) } });
    const failed = await startConversationRecoveries(async () => {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_sleep(0.08)`;
        await tx.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
      }, { timeout: 20 });
    });
    await Promise.all(failed.map(item => item.promise));
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'conversation_review_recovery_finished' } }), 0);
    const timeout = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'conversation_review_recovery_failed' } });
    assert.match(JSON.stringify(timeout.payload), /Transaction|expired|closed/);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'conversation_review_recovery_started' } }), 0,
      'A real database timeout must not consume the original continuation request');
    for (let index = 0; index < 20; index++) {
      const consumed = await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id,
        kind: 'conversation_review_recovery_requested', idempotencyKey: `fixture:consumed:${index}`, payload: { recoveryKind: 'implementation' } } });
      await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, kind: 'conversation_review_recovery_finished',
        idempotencyKey: `conversation:review-recovery:${consumed.id}:started:finished`, payload: {} } });
    }
    const batches = await Promise.all([startConversationRecoveries(recoverTaskGraphNode), startConversationRecoveries(recoverTaskGraphNode)]);
    await Promise.all(batches.flat().map(item => item.promise));
    await until(async () => (await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed_unverified');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'conversation_review_recovery_started' } }), 1, 'Deferred request eventually starts exactly once');
    const second = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(second.worktreePath, first.worktreePath);
    assert.notEqual(second.taskRunId, first.taskRunId);
    assert.notEqual(second.claimToken, first.claimToken);
    assert.equal(calls, 4, 'Blocked A resumes once, recollects automatically, then B starts once');
    assert.equal(executionProgress(second.dispatchMetadata)?.formatAttempts, 0);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'implementation_recovery_scheduled' } }), 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'implementation_blocked' } }), 1);
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: first.taskRunId } })).status, 'completed', 'Original attempt retained');
    await handleGraphConversationIntent({ ...request, messageId: 'terminal' });
    assert.equal(await handleGraphConversationIntent({ ...request, messageId: 'plain-status', text: '完成了吗？' }), false, 'Natural language is no longer a pre-model control API');
    assert.ok(notices.some(text => text.includes('原 Agent 继续工作')));
    // An old integrated-but-incomplete delivery is explicitly classified, not guessed from integrated.
    const delivery = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.id } });
    assert.ok(delivery.commit);
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, idempotencyKey: 'fixture-reclassify', kind: 'node_delivery_reclassified',
      payload: { recoveryKind: 'implementation', blockedPhase: 'implementation', executionId: first.id, taskRunId: delivery.taskRunId, checkpointCommit: delivery.commit, workspaceBase: baseline, reason: 'fixture integrated delivery was actually incomplete' } } });
    const deliveredProgress = executionProgress(delivery.dispatchMetadata); assert.ok(deliveredProgress);
    await prisma.taskGraphExecution.update({ where: { id: delivery.id }, data: { status: 'attention',
      dispatchMetadata: metadataWithProgress(delivery.dispatchMetadata, { ...deliveredProgress, revision: deliveredProgress.revision + 1,
        phase: 'implement', state: 'waiting_decision', candidateCommit: delivery.commit }),
    } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    const classified = await requestGraphConversationRecovery({ ...request, messageId: 'classified' });
    assert.equal(await graphRecoveryKind(node.id), 'implementation');
    await recoverTaskGraphNode(run.id, 'A', 'implementation', classified.id);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: first.id } })).status, 'ready');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'review_claimed' } }), 0);
    await until(async () => (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status === 'delivered_unverified');
    assert.equal(calls, 5, 'Historical incomplete delivery resumes implementation and can deliver again');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'delivered_unverified' } }), 2, 'Append a new delivery, retain the original');
    await until(async () => await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'workspace_cleanup_deferred' } }) >= 1);
    await drain();
    await cleanupFinishedWorkspaces();
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_workspaces_cleaned' } }), 0, 'Original Session references retain the path after delivery');
    assert.equal(readFileSync(path.join(second.worktreePath!, 'supplement.txt'), 'utf8'), 'new material');
    console.log('Real Git/DB: blocked/missing-result never integrate, saved progress survives deleted checkout, authorized continuation dedupes and resumes implementation, terminal remains unverified');
  } finally {
    await drain();
    const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, ...jobs.flatMap(job => job.childTaskId ? [job.childTaskId] : [])] } } });
    if (originalAdmin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID; else process.env.FEISHU_ADMIN_OPEN_ID = originalAdmin;
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
