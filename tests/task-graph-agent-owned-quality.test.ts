import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { createTaskGraphRun, approveHumanNode, releaseReadyNodes, submitNodeVerification, completeUnverifiedNode } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import type { GraphDefinition } from '../src/lib/task-graph/domain';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function scenario(mode: 'self' | 'multi' | 'conflict' | 'tester' | 'human' | 'repair' | 'implement' | 'format' | 'full' | 'self-repair' | 'architecture') {
  const multiple = mode === 'multi' || mode === 'conflict';
  let conflictResolutions = 0;
  const root = mkdtempSync(path.join(tmpdir(), 'agent-owned-quality-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repository, 'value'), 'base'); if (mode === 'conflict') writeFileSync(path.join(repository, 'shared'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const tester = { ...participant, harnessType: 'kimi-code', role: 'tester' };
  const command = [process.execPath, '-e', 'if(require("node:fs").readFileSync("value","utf8")!=="good")throw Error("behavior missing")'];
  const definition: GraphDefinition = { deliveryContract: 'agent_owned_v1', specRef: 'fixture://quality', nodes: [{
    key: 'A', goal: 'required behavior', dependsOn: [], executionMode: mode === 'implement' ? 'implement' : mode === 'full' || mode === 'architecture' ? 'full' : 'lean',
    ...((mode === 'full' || mode === 'architecture') ? { architectureReview: { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: { ...tester, role: 'reviewer' } } } } : {}),
    acceptance: { mode: mode === 'tester' || mode === 'repair' ? 'agent' : mode === 'human' ? 'human' : 'automatic',
      ...(mode === 'tester' || mode === 'repair' ? { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: tester } } : mode === 'human' ? { reviewerId: 'fixture-human' } : {}),
      checks: ['behavior'], integrationChecks: [{ name: 'joint', repository, argv: command }] },
    executions: [{ key: 'repo', instructions: 'implement behavior', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', launchConfig: { participant, checks: [{ name: 'behavior', argv: command }] } }],
  }] };
  if (multiple) definition.nodes[0].executions.push({ ...structuredClone(definition.nodes[0].executions[0]), key: 'other', agentSelector: 'local:kimi-code', launchConfig: { participant: { ...tester, role: 'implementer' }, checks: [{ name: 'behavior', argv: command }] } });
  definition.nodes.push({ ...structuredClone(definition.nodes[0]), key: 'B', dependsOn: ['A'], acceptance: { mode: 'automatic', checks: ['behavior'] } });
  const parent = await prisma.task.create({ data: { name: 'agent-owned fixture' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } }, include: { executions: true } });
  const adapter = getHarnessAdapter('codex')!, independent = getHarnessAdapter('kimi-code')!;
  const original = { execute: adapter.execute, resume: adapter.resume, tester: independent.execute, testerResume: independent.resume };
  let starts = 0, successorStarts = 0, reviews = 0, testerReviews = 0, commands = 0;
  const reviewedCommits: string[] = [];
  const codingTurns = new Map<string, number>();
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const { task, context } = args;
    const prompt = 'continuationMessage' in args ? args.continuationMessage : task.description || '';
    if (task.id.startsWith('task-graph-architecture-')) {
      const failed = mode === 'architecture' && task.name.startsWith('A') && starts === 1;
      const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      return { success: true, output: 'TASK_GRAPH_ARCH_REVIEW ' + JSON.stringify({ approved: !failed, note: 'approved architecture scope verified', ...(failed ? { failureKind: 'in_scope_defect', failureKey: 'architecture:scope', executionIds: jobs.map(job => job.id) } : {}) }), executionTime: 1 };
    }
    if (task.id.startsWith('task-graph-review-')) {
      assert.ok(mode === 'tester' || mode === 'repair', 'Self-check and Human modes must not start a Review TaskRun');
      const a = task.name.startsWith('A'); if (a) reviews++;
      if ((mode === 'tester' || mode === 'repair') && a) testerReviews++;
      const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id, key: a ? 'A' : 'B' } } });
      const checks = JSON.parse(prompt.match(/稳定检查 ID 和可回修执行：(\[[^\n]+\])。/)![1]);
      const workspaces = JSON.parse(prompt.match(/仓库检出目录: (\[[^\n]+\])\n证据:/)![1]);
      const workspace = workspaces[workspaces.length - 1];
      assert.match(prompt, /批准的仓内检查/);
      assert.ok(prompt.includes(JSON.stringify(command)), 'The exact approved argv is delivered to the quality owner');
      if (a) reviewedCommits.push(workspace.commit);
      let passed = true;
      try { commands++; execFileSync(command[0], command.slice(1), { cwd: workspace.path, stdio: 'pipe' }); } catch { passed = false; }
      assert.ok(!checks.some((check: { id: string }) => check.id === 'architecture:scope'), 'Acceptance must not require architecture evidence again');
      const decision = { approved: passed, note: `fixed behavior ${passed}`,
        ...(!passed ? { failureKind: 'in_scope_defect', failureKey: 'acceptance:behavior', executionIds: jobs.map(job => job.id) } : {}) };
      return { success: true, output: `TASK_GRAPH_REVIEW ${JSON.stringify(decision)}`, executionTime: 1 };
    }
    const a = task.name.startsWith('A'); if (a) starts++; else successorStarts++;
    const executionKey = task.name.split(' · ')[1];
    const codingKey = `${a ? 'A' : 'B'}-${executionKey}`;
    if (mode === 'conflict' && prompt.includes('受控冲突修复')) {
      conflictResolutions++;
      assert.equal(successorStarts, 0);
      writeFileSync(path.join(context.taskEnvironment!.AP_GRAPH_OUTPUT_DIR!, 'resolution.json'), JSON.stringify({ files: [{ path: 'shared', content: 'repo\nother\n' }] }));
      return { success: true, sessionId: `original-${codingKey}`, sessionKind: executionKey === 'other' ? 'kimi_session' : 'codex_thread', output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"resolved both changes","evidence":["resolution.json"]}', executionTime: 1 };
    }
    const turns = (codingTurns.get(codingKey) || 0) + 1; codingTurns.set(codingKey, turns);
    const native = multiple ? `original-${codingKey}` : a ? 'original-A' : 'original-B';
    const sessionKind = multiple && executionKey === 'other' ? 'kimi_session' : 'codex_thread';
    if (turns > 1) assert.equal('sessionId' in args ? args.sessionId : null, native, 'repair resumes the responsible implementor Session');
    if (mode === 'conflict' && a && turns === 1) writeFileSync(path.join(context.workingDirectory, 'shared'), `${executionKey}\n`);
    if (multiple) writeFileSync(path.join(context.workingDirectory, `${executionKey}.txt`), executionKey);
    writeFileSync(path.join(context.workingDirectory!, 'value'), a && ['repair', 'format', 'self-repair', 'architecture'].includes(mode) && starts === 1 ? 'bad' : 'good');
    if (a && mode === 'format' && starts === 1) return { success: true, sessionId: 'original-A', sessionKind: 'codex_thread', output: 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing blockerKind"}', executionTime: 1 };
    if (mode !== 'implement' && !(a && (mode === 'repair' || mode === 'architecture') && starts === 1)) {
      let passed = true;
      try { execFileSync(command[0], command.slice(1), { cwd: context.workingDirectory, stdio: 'pipe' }); } catch { passed = false; }
      if (!passed) return { success: true, sessionId: native, sessionKind, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"working","note":"self-check failed; fixing in the same Coding Session"}', executionTime: 1 };
    }
    return { success: true, sessionId: native, sessionKind, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implemented","evidence":["value"]}', executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute; independent.execute = execute; independent.resume = execute;
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); };
  try {
    for (let i = 0; i < 400; i++) {
      await runTaskGraphCycle();
      const current = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
      if (mode === 'human' && current.status === 'awaiting_human') {
        assert.equal(successorStarts, 0);
        const evidence = current.evidence;
        assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
        await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: 'intruder', evidence: JSON.parse(JSON.stringify(evidence)) }), /responsib|review|identity|actor/i);
        await assert.rejects(() => approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'intruder', approved: true, note: 'no' }), /Wrong human/);
        const pinned = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
        await prisma.taskGraphExecution.update({ where: { id: pinned.id }, data: { commit: 'c'.repeat(40) } });
        await assert.rejects(() => approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'fixture-human', approved: true, note: 'stale approval' }), /input commits/);
        await prisma.taskGraphExecution.update({ where: { id: pinned.id }, data: { commit: pinned.commit } });
        const writers = createRequire(__filename)('../src/lib/task-graph/writer-ownership');
        const observe = writers.observeTaskRunWriter;
        writers.observeTaskRunWriter = async (id: string) => { if (id === pinned.taskRunId) throw new Error('Human approval must not repeat Agent runtime inspection'); return observe(id); };
        try { await approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'fixture-human', approved: true, note: 'approved fixed evidence' }); }
        finally { writers.observeTaskRunWriter = observe; }
        await releaseReadyNodes(run.id);
      }
      if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === (mode === 'implement' ? 'completed_unverified' : 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await drain();
    const after = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
    assert.equal(after.status, mode === 'implement' ? 'delivered_unverified' : 'passed', JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, take: 5, orderBy: { createdAt: 'desc' } })));
    if (multiple) assert.ok(starts >= 2); else assert.equal(starts, ['repair', 'format', 'self-repair', 'architecture'].includes(mode) ? 2 : 1);
    assert.equal(reviews, mode === 'repair' ? 2 : mode === 'tester' ? 1 : 0, 'Only the configured Tester starts a review');
    assert.equal(testerReviews, mode === 'tester' || mode === 'repair' ? reviews : 0);
    assert.ok(successorStarts >= definition.nodes[1].executions.length);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'node_ready', node: { key: 'B' } } }), 1, 'Successor Ticket releases exactly once');
    if (multiple) {
      const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      assert.equal(new Set(jobs.map(job => git('rev-parse', `${job.commit}^{tree}`))).size, 1, 'Each implementor self-checks the fixed combined source, in its own Coding Session');
      assert.ok(codingTurns.has('A-repo') && codingTurns.has('A-other'));
    }
    if (mode === 'conflict') { assert.equal(conflictResolutions, 1); const final = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } }); assert.equal(git('show', `${final.commit}:shared`), 'repo\nother'); }
    assert.equal(commands, reviews, 'Platform never executes the approved business command');
    if (mode === 'repair') assert.notEqual(reviewedCommits[0], reviewedCommits[1]);
    if (mode !== 'implement') await assert.rejects(() => completeUnverifiedNode(run.id, 'A'), /approved implement-only/i);
    console.log(`agent-owned ${mode}: fixed quality, repair, human boundary, successor verified`);
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume; independent.execute = original.tester; independent.resume = original.testerResume;
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename), notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {}; notices.sendGraphHumanReviewCard = async () => {};
  require('../src/lib/task-graph/check-environment').runSandboxedGraphCheck = async () => { throw new Error('Agent-owned contracts must not execute platform business checks'); };
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  try { for (const mode of ['self', 'multi', 'conflict', 'tester', 'human', 'repair', 'implement', 'format', 'full', 'self-repair', 'architecture'] as const) if (!process.env.GRAPH_QUALITY_CASE || process.env.GRAPH_QUALITY_CASE === mode) await scenario(mode); }
  finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
