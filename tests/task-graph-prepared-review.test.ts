import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, recoverTaskGraphNodeVerification, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { inspectPreparedReviewBinding, registerPreparedReviewRecovery } from '../src/lib/task-graph/preparation-recovery';
import { getHarnessAdapter } from '../src/lib/harness';
import type { GraphDefinition } from '../src/lib/task-graph/domain';
import type { Prisma } from '@prisma/client';

async function scenario(passes: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'prepared-review-')), repository = path.join(root, 'project'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'value'), 'baseline'); git('add', '.'); git('commit', '-m', 'baseline');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const definition: GraphDefinition = { specRef: 'fixture://prepared-review', nodes: [{ key: 'A', goal: 'review', dependsOn: [], executionMode: 'lean',
    acceptance: { mode: 'agent', reviewerId: 'local:kimi-code', checks: ['behavior'], reviewLaunchConfig: { participant: { ...participant, harnessType: 'kimi-code', role: 'tester' } } },
    executions: [{ key: 'model', repository, baseCommit: git('rev-parse', 'HEAD'), gitRef: 'refs/heads/main', instructions: 'implement', agentSelector: 'local:codex', launchConfig: { participant, checks: [{ name: 'behavior', argv: ['node', '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("value","utf8"),"delivered")'] }] } }] }] };
  definition.nodes.push({ key: 'NEXT', goal: 'successor', dependsOn: ['A'], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ ...definition.nodes[0].executions[0], key: 'next' }] });
  const parent = await prisma.task.create({ data: { name: 'prepared review' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  let implementations = 0, reviews = 0, fixed = false, successors = 0;
  getHarnessAdapter('codex')!.execute = async ({ task, context }) => {
    if (task.name.startsWith('NEXT')) successors++; else implementations++;
    writeFileSync(path.join(context.workingDirectory!, 'value'), 'delivered');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["value"]}', executionTime: 1 };
  };
  getHarnessAdapter('kimi-code')!.execute = async () => { reviews++; return fixed && passes ? { success: true, executionTime: 1, output: 'TASK_GRAPH_REVIEW {"approved":true,"note":"checked"}' } : { success: false, executionTime: 1, output: 'platform transport failed' }; };
  const getNode = () => prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } }, include: { executions: true } });
  async function cycleUntil(terminal: 'attention' | 'passed') {
    for (let n = 0; n < 400; n++) { await runTaskGraphCycle(); if ((await getNode()).status === terminal) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    const failed = await getNode();
    throw new Error('Coordinator did not reach ' + terminal + ': ' + JSON.stringify({ status: failed.status, jobs: failed.executions.map(job => ({ status: job.status, progress: executionProgress(job.dispatchMetadata) })), reviews, events: await prisma.taskGraphEvent.findMany({ where: { nodeId: failed.id }, orderBy: { createdAt: 'desc' }, take: 3, select: { kind: true, payload: true } }) }));
  }
  try {
    await cycleUntil('attention');
    const before = await getNode(), job = before.executions[0], progress = executionProgress(job.dispatchMetadata)!;
    assert.equal(progress.state, 'exhausted'); assert.equal(progress.platformAttempts, 2); assert.equal(reviews, 3);
    await assert.rejects(recoverTaskGraphNodeVerification(run.id, 'A'), /exhaustion/);
    const key = `runtime-snapshot:${job.id}:${job.claimToken}`;
    const saved = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { runId_idempotencyKey: { runId: run.id, idempotencyKey: key } } });
    const payload = saved.payload as Prisma.JsonObject, snapshot = payload.snapshot as Prisma.JsonObject;
    const declaration = { version: 1 }, manifestHash = createHash('sha256').update(JSON.stringify(declaration)).digest('hex');
    const identity = createHash('sha256').update(JSON.stringify({ manifestHash, resources: [] })).digest('hex');
    await prisma.taskGraphEvent.update({ where: { id: saved.id }, data: { payload: { ...payload, snapshot: { ...snapshot, identity,
      source: { origin: 'host_registration', commit: '1'.repeat(40), filename: path.join(root, 'runtime-resources.json'), declaration, manifestHash, registrationHash: '2'.repeat(64) } } } } });
    const artifact = path.join(root, 'new-measure.json'); writeFileSync(artifact, 'verified new platform fix');
    const receipt = { version: 1, runId: run.id, nodeKey: 'A', requestId: 'fix-1', authorization: 'fixture operator approved new measure', changeReason: 'verified environment repair', readiness: 'local_operator_attested', remediation: 'missing_capability',
      bindingHash: await inspectPreparedReviewBinding(run.id, 'A'), artifacts: [{ path: artifact, sha256: createHash('sha256').update('verified new platform fix').digest('hex') }] };
    const remediation = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await assert.rejects(registerPreparedReviewRecovery({ ...receipt, bindingHash: '0'.repeat(64) }, remediation), /binding changed/);
    writeFileSync(artifact, 'changed'); await assert.rejects(registerPreparedReviewRecovery(receipt, remediation), /hash mismatch/); writeFileSync(artifact, 'verified new platform fix');
    const launchDirectory = process.cwd();
    let registered: Awaited<ReturnType<typeof registerPreparedReviewRecovery>>;
    process.chdir(root);
    try { registered = await registerPreparedReviewRecovery(receipt, remediation); }
    finally { process.chdir(launchDirectory); }
    assert.equal(registered.kind, 'registered'); assert.equal((await registerPreparedReviewRecovery(receipt, remediation)).kind, 'already_registered');
    const ready = executionProgress((await getNode()).executions[0].dispatchMetadata)!;
    assert.equal(ready.worker, undefined); assert.equal(ready.workerReleasedAt, undefined); assert.equal(ready.platformAttempts, 2); assert.equal(ready.candidateCommit, progress.candidateCommit);
    fixed = true; await cycleUntil(passes ? 'passed' : 'attention');
    assert.equal(implementations, 1, 'Prepared acceptance does not rerun implementation'); assert.equal(reviews, 4, 'Exactly one new claim runs through coordinator recovery');
    const after = await getNode(); assert.equal(executionProgress(after.executions[0].dispatchMetadata)?.platformAttempts, 2, 'No retry budget replenished');
    if (!passes) {
      assert.equal(executionProgress(after.executions[0].dispatchMetadata)?.state, 'exhausted');
      await assert.rejects(registerPreparedReviewRecovery({ ...receipt, requestId: 'same-fix-again', bindingHash: await inspectPreparedReviewBinding(run.id, 'A') }, remediation), /already authorized/);
      assert.equal((await registerPreparedReviewRecovery(receipt, remediation)).kind, 'already_registered'); assert.equal((await getNode()).status, 'attention');
    } else {
      for (let n = 0; n < 150 && !successors; n++) { await runTaskGraphCycle(); await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.equal(successors, 1, 'Successor starts without human resume');
    }
    console.log(`Prepared review ${passes ? 'passes and unlocks successor' : 'fails once and stays exhausted'}; candidates and budgets retained; duplicate measure rejected`);
  } finally { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); await prisma.taskGraphRun.delete({ where: { id: run.id } }); rmSync(root, { recursive: true, force: true }); }
}

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  try { await scenario(true); await scenario(false); } finally { globalThis.fetch = original; await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
