import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';
import { receiveGraphTaskMessage } from '../src/lib/task-graph/conversation-inbox';
import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';
import { maxUnchangedWorkTurns } from '../src/lib/task-graph/retry-limits';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'auto-completion-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repository, 'baseline'), 'preserve'); git('add', '.'); git('commit', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename); const notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  const calls = new Map<string, number>();
  const adapter = getHarnessAdapter('codex'); assert.ok(adapter);
  const original = { execute: adapter.execute, resume: adapter.resume };
  let recoveryDescription = '', resumedCorrectionDescription = '';
  let resumeReceipt = false;
  const directories = new Map<string, string>();
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const { task, context } = args;
    const key = task.name.split(' · ')[0]; const count = (calls.get(key) || 0) + 1; calls.set(key, count);
    if (count > 1) {
      assert.equal('sessionId' in args ? args.sessionId : null, `native-${key}`, 'Correction must resume the original native Session');
      assert.equal(context.workingDirectory, directories.get(key), 'Correction retains original Worktree');
      assert.notEqual(context.permissionConfig?.sandboxMode, 'read-only');
    } else directories.set(key, context.workingDirectory);
    const reply = (output: string) => ({ success: true, output, sessionId: `native-${key}`, sessionKind: 'codex_thread', executionTime: 1 });
    if (key === 'D' && resumeReceipt) resumedCorrectionDescription = 'continuationMessage' in args ? args.continuationMessage : task.description || '';
    if (key === 'A' && count === 2) recoveryDescription = 'continuationMessage' in args ? args.continuationMessage : task.description || '';
    if (key === 'F' && count === 2) await receiveGraphTaskMessage({ taskId: task.id, sourceId: 'new-approved-input', actorId: owner.id, actorOrigin: 'platform', content: 'Continue using the approved fixture input.' });
    if (key === 'C' || key === 'D') {
      const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id }, orderBy: { createdAt: 'desc' } });
      // Keep synthetic tool previews clear of the runner's concurrent lifecycle events.
      await prisma.taskRunEvent.create({ data: { taskRunId: turn.id, sequence: 1000 + count, eventType: 'control_message',
        content: `工具：Bash · write evidence/${turn.id}/resume-receipt.json; check missing skills`, metadata: JSON.stringify({ kind: 'tool', toolName: 'Bash' }) } });
    }
    const value = (key === 'A' && count < 3 || key === 'H' && count < 5) ? `in-progress-${count}` : 'fixed';
    writeFileSync(path.join(context.workingDirectory!, `${key}.txt`), value);
    if (key === 'D' && !resumeReceipt || key === 'A' && count === 1 || key === 'E' && count === 1 || key === 'F' && count < 4 || key === 'G' && count < 3 || key === 'H' && count < 5) return reply('TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"required skills missing","evidence":["resume-receipt.json"]}');
    if (key === 'E' && count < 4) return reply('TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"evidence field missing"}');
    if (key === 'A' && count === 2 || key === 'C' || key === 'G' && count < 6) return reply('No delivery conclusion; continuing normal engineering work');
    return reply(`TASK_GRAPH_IMPLEMENTATION ${JSON.stringify({ status: 'delivered', note: `${key} implemented`, evidence: [`${key}.txt`] })}`);
  };
  adapter.execute = execute; adapter.resume = execute;
  const owner = await prisma.user.create({ data: { username: root, passwordHash: 'fixture', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'automatic repair fixture', ownerUserId: owner.id } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://automatic-repair', nodes: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(key => ({
      key, goal: `Complete ${key}`, dependsOn: key === 'B' ? ['A'] : [], executionMode: 'lean',
      acceptance: { mode: 'automatic', checks: ['behavior'] }, executions: [{ key: 'repo', repository,
        gitRef: 'refs/heads/main', baseCommit: baseline, agentSelector: 'local:codex', instructions: `Implement ${key}`,
        launchConfig: { participant, checks: [{ name: 'behavior', argv: [process.execPath, '-e', `if(require('node:fs').readFileSync('${key}.txt','utf8')!=='fixed')throw Error('required behavior is missing')`] }] },
      }],
    })),
  } });
  const drain = async () => { const signal = new AbortController(); signal.abort(); await startTaskGraphCoordinator(signal.signal); };
  try {
    let completed = false;
    for (let i = 0; i < 700; i++) {
      await runTaskGraphCycle();
      const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, select: { key: true, status: true } });
      assert.ok(!nodes.some(node => node.key === 'A' && node.status === 'attention'));
      if (nodes.every(node => ['C', 'D'].includes(node.key) ? node.status === 'attention' : node.status === 'passed')) { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.match(recoveryDescription, /实施阻塞结论缺少有效 blockerKind/, 'Actual correction turn must explain the missing blockerKind');
    assert.doesNotMatch(recoveryDescription, /不重新实施或修改源码|仅补收已有成果/, 'Correction remains normal engineering work');
    assert.ok(completed, 'The original ticket, successor and independent branch must finish without human resume');
    assert.equal(calls.get('A'), 3); assert.equal(calls.get('B'), 1); assert.equal(calls.get('C'), maxUnchangedWorkTurns + 1);
    assert.equal(calls.get('E'), 4, 'A different concrete format error starts a new correction allowance');
    assert.equal(calls.get('H'), 5, 'Changed source content is progress even when the same format error recurs');
    assert.equal(calls.get('G'), 6, 'Ordinary progress turns do not inherit the format-correction allowance');
    assert.equal(calls.get('F'), 4, 'New approved input starts a new correction allowance');
    const delivered = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'A' } } });
    assert.ok(delivered.commit);
    assert.equal(git('show', `${delivered.commit}:A.txt`), 'fixed', 'Delivered candidate binds the final changed Worktree, not the first saved snapshot');
    const evidence = delivered.evidence;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
    const implementation = evidence.implementation;
    assert.ok(implementation && typeof implementation === 'object' && !Array.isArray(implementation));
    assert.equal(implementation.status, 'delivered');
    assert.equal(evidence.taskRunId, delivered.taskRunId);
    const correctionOutcomes = await prisma.taskGraphEvent.findMany({ where: { nodeId: delivered.nodeId, kind: 'execution_outcome', payload: { path: ['outcome', 'kind'], equals: 'result_incomplete' } } });
    assert.equal(correctionOutcomes.length, 1, 'Marker-free progress after format correction returns to normal implementation');
    assert.equal(calls.get('D'), 3, 'Malformed blocked receipts with fresh evidence paths stop instead of spinning');
    const invalid = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'D' } } });
    assert.equal(executionProgress(invalid.dispatchMetadata)?.lastFailure?.code, 'invalid_result');
    assert.equal(invalid.commit, null);
    const waiting = await prisma.taskGraphExecution.findFirstOrThrow({where:{node:{runId:run.id,key:'C'}}});
    assert.equal(executionProgress(waiting.dispatchMetadata)?.state, 'waiting_for_user');
    assert.equal(executionProgress(waiting.dispatchMetadata)?.formatAttempts, 0); assert.equal(waiting.commit, null);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: { in: ['conversation_review_recovery_requested', 'implementation_recovery_scheduled'] } } }), 0);
    for (let i = 0; i < 8; i++) { await runTaskGraphCycle(); await new Promise(resolve => setTimeout(resolve, 30)); }
    await drain(); assert.equal(calls.get('D'), 3, 'Conditions scanning must not add a third unchanged correction');
    const legacyJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: invalid.id } });
    // Older coordinators retained collect_result at the unchanged-format stop, as in real M6.
    await prisma.taskGraphExecution.update({ where: { id: legacyJob.id }, data: { dispatchMetadata: metadataWithProgress(legacyJob.dispatchMetadata, { ...executionProgress(legacyJob.dispatchMetadata)!, phase: 'collect_result' }) } });
    resumeReceipt = true;
    assert.equal((await scheduleImplementationRecovery(run.id, 'D', 'explicit-receipt-correction')).kind, 'scheduled');
    for (let i = 0; i < 200; i++) {
      await runTaskGraphCycle();
      const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'D' } } });
      if (node.status === 'passed') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await drain();
    assert.match(resumedCorrectionDescription, /实施阻塞结论缺少有效 blockerKind/, 'Admission clears stale wait reasons, but the bound malformed receipt must still yield its concrete error');
    assert.doesNotMatch(resumedCorrectionDescription, /回执格式错误：undefined/);
    assert.equal(calls.get('D'), 4);
    console.log('Real coordinator: ordinary output continues implementation; two unchanged format corrections, ordinary work and changed errors/inputs continue; final candidate binds delivery; successor once; admitted legacy correction retains concrete format error');
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume;
    const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } }, select: { childTaskId: true } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, ...jobs.flatMap(job => job.childTaskId ? [job.childTaskId] : [])] } } });
    await prisma.user.delete({ where: { id: owner.id } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
