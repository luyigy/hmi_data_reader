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
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import type { GraphDefinition } from '../src/lib/task-graph/domain';
import { qualityCheckEvidence } from '../src/lib/task-graph/quality-contract';
import { classifyReview } from '../src/lib/task-graph/review-contract';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function scenario(mode: 'self' | 'tester' | 'human' | 'repair' | 'implement' | 'format' | 'full' | 'self-repair' | 'architecture') {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-owned-quality-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repository, 'value'), 'base'); git('add', '.'); git('commit', '-m', 'base');
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
  definition.nodes.push({ ...structuredClone(definition.nodes[0]), key: 'B', dependsOn: ['A'], acceptance: { mode: 'automatic', checks: ['behavior'] } });
  const parent = await prisma.task.create({ data: { name: 'agent-owned fixture' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } }, include: { executions: true } });
  const adapter = getHarnessAdapter('codex')!, independent = getHarnessAdapter('kimi-code')!;
  const original = { execute: adapter.execute, resume: adapter.resume, tester: independent.execute };
  let starts = 0, successorStarts = 0, reviews = 0, testerReviews = 0, commands = 0;
  const reviewedCommits: string[] = [];
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const { task, context } = args;
    const prompt = 'continuationMessage' in args ? args.continuationMessage : task.description || '';
    if (task.id.startsWith('task-graph-architecture-')) {
      const failed = mode === 'architecture' && task.name.startsWith('A') && starts === 1;
      const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      return { success: true, output: 'TASK_GRAPH_ARCH_REVIEW ' + JSON.stringify({ approved: !failed, note: 'approved architecture scope verified', ...(failed ? { failureKind: 'in_scope_defect', failureKey: 'architecture:scope', executionIds: jobs.map(job => job.id) } : {}) }), executionTime: 1 };
    }
    if (task.id.startsWith('task-graph-review-')) {
      const a = task.name.startsWith('A'); if (a) reviews++;
      if ((mode === 'tester' || mode === 'repair') && a) testerReviews++;
      const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id, key: a ? 'A' : 'B' } } });
      const checks = JSON.parse(prompt.match(/稳定检查 ID 和可回修执行：(\[[^\n]+\])。/)![1]);
      const workspaces = JSON.parse(prompt.match(/仓库检出目录: (\[[^\n]+\])\n证据:/)![1]);
      const workspace = workspaces[workspaces.length - 1];
      assert.match(prompt, /批准的验证命令/);
      assert.ok(prompt.includes(JSON.stringify(command)), 'The exact approved argv is delivered to the quality owner');
      if (a) reviewedCommits.push(workspace.commit);
      let passed = true;
      try { commands++; execFileSync(command[0], command.slice(1), { cwd: workspace.path, stdio: 'pipe' }); } catch { passed = false; }
      const results = checks.map((check: { id: string }) => ({ name: check.id, passed, evidence: `actual command on ${workspace.commit}: ${passed}` }));
      const decision = { approved: passed, note: `fixed behavior ${passed}`, checks: results,
        ...(!passed ? { failureKind: 'in_scope_defect', failureKey: 'acceptance:behavior', executionIds: jobs.map(job => job.id) } : {}) };
      return { success: true, output: `TASK_GRAPH_REVIEW ${JSON.stringify(decision)}`, executionTime: 1 };
    }
    const a = task.name.startsWith('A'); if (a) starts++; else successorStarts++;
    if (a && starts > 1) assert.equal('sessionId' in args ? args.sessionId : null, 'original-A', 'repair resumes implementor Session');
    writeFileSync(path.join(context.workingDirectory!, 'value'), a && ['repair', 'format', 'self-repair', 'architecture'].includes(mode) && starts === 1 ? 'bad' : 'good');
    if (a && mode === 'format' && starts === 1) return { success: true, sessionId: 'original-A', sessionKind: 'codex_thread', output: 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing blockerKind"}', executionTime: 1 };
    return { success: true, sessionId: a ? 'original-A' : 'original-B', sessionKind: 'codex_thread', output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implemented","evidence":["value"]}', executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute; independent.execute = execute;
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
        await approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'fixture-human', approved: true, note: 'approved fixed evidence' });
        await releaseReadyNodes(run.id);
      }
      if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await drain();
    const after = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
    assert.equal(after.status, 'passed', JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, take: 5, orderBy: { createdAt: 'desc' } })));
    assert.equal(starts, ['repair', 'format', 'self-repair', 'architecture'].includes(mode) ? 2 : 1);
    assert.equal(reviews, mode === 'repair' || mode === 'self-repair' ? 2 : 1, 'quality responsibility executes on fixed commit');
    assert.equal(testerReviews, mode === 'tester' || mode === 'repair' ? reviews : 0);
    assert.equal(successorStarts, 1);
    assert.equal(commands, reviews + 1, 'one quality owner per fixed version');
    if (mode === 'repair') assert.notEqual(reviewedCommits[0], reviewedCommits[1]);
    await assert.rejects(() => completeUnverifiedNode(run.id, 'A'), /agent.owned|contract/i);
    const proof = JSON.parse(JSON.stringify(after.evidence));
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    const binding = executionProgress(job.dispatchMetadata)?.review;
    assert.ok(binding?.kind === 'running');
    const publication = { phase: 'acceptance' as const, claimKey: binding.claimKey, taskRunId: binding.taskRunId, outcome: 'classified' as const };
    const owner = mode === 'tester' || mode === 'repair' ? 'local:kimi-code' : 'local:codex';
    await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: owner, evidence: { ...proof, inputs: [] } }), /input|commit|version/i);
    await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: owner, evidence: proof }), /review|ownership|publication/i);
    await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: 'intruder', evidence: proof, review: publication }), /responsible/);
    await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: owner, evidence: { ...proof, checks: proof.checks.slice(1) }, review: publication }), /evidence/);
    const forged = { ...proof, checks: proof.checks.map((item: { evidence: string }) => ({ ...item, evidence: 'invented proof' })) };
    await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: owner, evidence: forged, review: publication }), /does not match/);
    assert.equal((await submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: owner, evidence: proof, review: publication })).status, 'passed', 'matching publication is idempotent');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { commit: 'c'.repeat(40) } });
    await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: owner, evidence: proof, review: publication }), /input commits/);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { commit: job.commit } });
    console.log(`agent-owned ${mode}: fixed quality, repair, human boundary, successor verified`);
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume; independent.execute = original.tester;
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    rmSync(root, { recursive: true, force: true });
  }
}
function evidenceBoundary() {
  const checks = ['A', 'B'].map(id => ({ id, name: id, executionIds: ['repo'] }));
  const result = { approved: true, note: 'actual quality evidence', checks: checks.map(check => ({ name: check.id, passed: true, evidence: 'actual output' })) };
  assert.equal(classifyReview({ approved: true, note: 'legacy compatible' }, checks)?.approved, true);
  assert.equal(classifyReview({ approved: true, note: 'missing' }, checks, true), null);
  assert.equal(classifyReview({ ...result, checks: result.checks.slice(1) }, checks, true), null);
  assert.equal(classifyReview({ ...result, checks: [...result.checks, result.checks[0]] }, checks, true), null);
  assert.equal(classifyReview({ ...result, checks: result.checks.map(item => ({ ...item, passed: 'true' })) }, checks, true), null);
  assert.equal(classifyReview({ ...result, checks: result.checks.map(item => ({ ...item, passed: false })) }, checks, true), null);
  assert.equal(classifyReview(result, checks, true)?.approved, true);
  const mapped = qualityCheckEvidence({ key: 'fixture', goal: 'mixed checks', dependsOn: [], executions: [], acceptance: { mode: 'automatic', checks: ['A', 'B'] } }, checks.map(item => ({ ...item, id: `acceptance:${item.id}` })), {
    approved: false, note: 'B failed', failureKind: 'in_scope_defect', failureKey: 'acceptance:B', executionIds: ['repo'],
    checks: [{ name: 'acceptance:A', passed: true, evidence: 'A passed' }, { name: 'acceptance:B', passed: false, evidence: 'B failed' }],
  });
  assert.deepEqual(mapped.map(item => item.passed), [true, false], 'Platform preserves mixed Agent judgments');
}
async function main() {
  evidenceBoundary();
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename), notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {}; notices.sendGraphHumanReviewCard = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  try { for (const mode of ['self', 'tester', 'human', 'repair', 'implement', 'format', 'full', 'self-repair', 'architecture'] as const) await scenario(mode); }
  finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
