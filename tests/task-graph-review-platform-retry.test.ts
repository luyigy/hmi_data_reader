import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, startTaskGraphCoordinator, recoverTaskGraphNode, recoverTaskGraphNodeVerification } from '../src/lib/task-graph/coordinator';
import { observeTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { TaskInputPreparationError } from '../src/lib/task-graph/upstream-inputs';
import { GraphCheckTimeoutError } from '../src/lib/task-graph/check-runner';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function scenario(mode: 'platform' | 'platform-exhausted' | 'architecture-platform' | 'human' | 'preparation' | 'preparation-exhausted' | 'integration-timeout' | 'ownership' | 'startup' | 'startup-network') {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-targeted-review-'));
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'harness'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const repositories = ['reader', 'model'].map(key => {
    const repository = path.join(root, key); mkdirSync(repository);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(path.join(repository, 'value'), 'baseline'); git('add', '.'); git('commit', '-m', 'baseline');
    return { key, repository, baseCommit: git('rev-parse', 'HEAD') };
  });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const reviewer = { ...participant, harnessType: 'kimi-code', role: 'tester' };
  const definition: GraphDefinition = { specRef: 'fixture://targeted-review', nodes: [{ key: 'BOTH', goal: 'joint behavior', dependsOn: [], executionMode: mode === 'architecture-platform' ? 'full' : 'lean',
    ...(mode === 'architecture-platform' ? { architectureReview: { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: reviewer } } } : {}),
    acceptance: { mode: 'agent', reviewerId: 'local:kimi-code', checks: ['joint'], reviewLaunchConfig: { participant: reviewer },
      integrationChecks: [{ name: 'joint', repository: repositories[0].repository, argv: ['python3', '-c', 'from pathlib import Path; import os; Path(os.environ["AP_GRAPH_OUTPUT_DIR"],"joint-proof.txt").write_text("checked"); assert Path("value").read_text() == '+JSON.stringify('bad')+' or Path("value").read_text()=="good"'] }] },
    executions: repositories.map(repo => ({ ...repo, gitRef: 'refs/heads/main', agentSelector: 'local:codex', instructions: repo.key, launchConfig: { participant, checks: [] } })) }] };
  definition.nodes.push({ key: 'NEXT', goal: 'automatic successor', dependsOn: ['BOTH'], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ ...definition.nodes[0].executions[1], key: 'next', instructions: 'successor' }] });
  const parent = await prisma.task.create({ data: { name: `targeted ${mode}` } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'BOTH' } }, include: { executions: true } });
  const reader = node.executions.find(job => job.key === 'reader')!;
  let readerStarts = 0, modelStarts = 0, architectureStarts = 0, acceptanceStarts = 0, nextStarts = 0;
  let modelEvidence: unknown;
  let modelCommit: string | null = null;
  getHarnessAdapter('codex')!.execute = async ({ context, task }) => {
    if (task.name.startsWith('NEXT')) { nextStarts++; writeFileSync(path.join(context.workingDirectory!, 'next.txt'), 'next delivered'); return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"successor","evidence":["next.txt"]}', executionTime: 1 }; }
    const isReader = task.name.endsWith('reader');
    if (isReader) readerStarts++; else modelStarts++;
    writeFileSync(path.join(context.workingDirectory!, 'value'), isReader ? readerStarts > 1 ? 'good' : 'bad' : 'model delivered');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implementation","evidence":["value"]}', executionTime: 1 };
  };
  getHarnessAdapter('kimi-code')!.execute = async ({ task, context }) => {
    const architecture = task.id.startsWith('task-graph-architecture-');
    if (architecture) architectureStarts++; else acceptanceStarts++;
    const sibling = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id, key: 'model' } });
    if (!modelCommit) { modelCommit = sibling.commit; modelEvidence = sibling.evidence; }
    const marker = architecture ? 'TASK_GRAPH_ARCH_REVIEW' : 'TASK_GRAPH_REVIEW';
    if (mode === 'platform-exhausted' || (mode === 'platform' && !architecture && acceptanceStarts === 1 || mode === 'architecture-platform' && architecture && architectureStarts === 1)) return { success: false, output: 'temporary transport failure', executionTime: 1 };
    if (mode === 'human') return { success: true, output: `${marker} {"approved":false,"note":"requires explicit scope decision","failureKind":"blocked_require_human"}`, executionTime: 1 };
    return { success: true, output: `${marker} {"approved":true,"note":"joint behavior checked"}`, executionTime: 1 };
  };
  const require = createRequire(__filename);
  const checks: typeof import('../src/lib/task-graph/check-environment') = require('../src/lib/task-graph/check-environment');
  const runCheck = checks.runSandboxedGraphCheck;
  const events: { publishTaskRunEvent: typeof import('../src/lib/acpx/event-bus').publishTaskRunEvent } = require('../src/lib/acpx/event-bus');
  const publishEvent = events.publishTaskRunEvent;
  let startupFailureRun: string | undefined;
  events.publishTaskRunEvent = async event => {
    if (mode.startsWith('startup') && !startupFailureRun && event.eventType === 'participant_started' && event.taskId === `task-graph-${reader.id}`) {
      startupFailureRun = event.taskRunId;
      assert.equal(readerStarts, 0, 'Fault is injected before any model starts');
      if (mode === 'startup-network') throw new Error('Transport unavailable', { cause: Object.assign(new Error('Injected connection reset'), { code: 'ECONNRESET' }) });
      throw new Prisma.PrismaClientKnownRequestError('Injected participant_started connection pool timeout', { code: 'P2024', clientVersion: Prisma.prismaVersion.client });
    }
    return publishEvent(event);
  };

  let preparationAttempts = 0;
  checks.runSandboxedGraphCheck = async (...args: Parameters<typeof runCheck>) => {
    if (String(args[2]?.AP_GRAPH_SERVICE_TASK_ID).startsWith('task-graph-review-') && ['preparation', 'preparation-exhausted', 'integration-timeout', 'ownership'].includes(mode)) {
      preparationAttempts++;
      if (mode === 'preparation-exhausted' || preparationAttempts === 1) {
        if (mode === 'ownership') throw new Error('Unregistered workspace identity');
        if (mode === 'integration-timeout') throw new GraphCheckTimeoutError('Integration process timed out');
        throw new TaskInputPreparationError('temporary input preparation failure', 'environment_failed');
      }
    }
    return runCheck(...args);
  };
  try {
    for (let n = 0; n < 600; n++) {
      await runTaskGraphCycle();
      const idle = new AbortController(); idle.abort(); await startTaskGraphCoordinator(idle.signal);
      const status = (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status;
      if (['completed', 'completed_unverified'].includes((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status) || status === 'attention') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    if (mode.endsWith('exhausted')) {
      // Exercise further Coordinator cycles: one verified condition identity may
      // retry, but an unchanged condition receipt must not launch models forever.
      for (let cycle = 0; cycle < 8; cycle++) {
        await runTaskGraphCycle(); const idle = new AbortController(); idle.abort(); await startTaskGraphCoordinator(idle.signal);
      }
    }
    const after = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
    const exhausted = mode.endsWith('exhausted'), human = mode === 'human', ownership = mode === 'ownership';
    assert.equal(after.status, exhausted || human || ownership ? 'attention' : 'passed', JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'desc' }, take: 8 })));
    assert.equal(readerStarts, 1); assert.equal(modelStarts, 1, 'Platform review failure never reruns implementation');
    assert.equal(nextStarts, exhausted || human || ownership ? 0 : 1);
    assert.equal(architectureStarts + acceptanceStarts, mode === 'preparation-exhausted' || ownership ? 0 : exhausted ? 4 : human || mode === 'preparation' || mode === 'integration-timeout' || mode.startsWith('startup') ? 1 : mode === 'architecture-platform' ? 3 : 2);
    assert.ok(after.executions.every(job => executionProgress(job.dispatchMetadata)?.state === (exhausted ? 'exhausted' : ownership ? 'ownership_attention' : human ? 'waiting_decision' : 'active')));
    assert.ok(after.executions.every(job => job.commit && job.evidence));
    if (mode.startsWith('startup')) {
      assert(startupFailureRun);
      assert.equal(executionProgress(after.executions.find(job => job.id === reader.id)!.dispatchMetadata)?.platformAttempts, 1, 'Typed transient startup failure consumes exactly one platform retry');
      const failed = await prisma.taskRun.findUniqueOrThrow({ where: { id: startupFailureRun }, include: { participants: true } });
      assert.equal(failed.status, 'failed');
      assert.ok(failed.participants.every(participant => participant.status === 'failed'));
      assert.equal((await observeTaskRunWriter(failed.id)).kind, 'exited', 'Failed prelaunch runner is released in the same live daemon');
      assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'implementation_recovery_requested' } }), 0);
    }

    if (exhausted || human || ownership) assert.ok(after.executions.every(job => executionProgress(job.dispatchMetadata)?.lastFailure));
    if (ownership) await assert.rejects(recoverTaskGraphNodeVerification(run.id, 'BOTH'), /ownership/);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 0);
    if (human) {
      const budgets = after.executions.map(job => executionProgress(job.dispatchMetadata)?.platformAttempts);
      getHarnessAdapter('kimi-code')!.execute = async () => { acceptanceStarts++; return { success: true, executionTime: 1, output: 'TASK_GRAPH_REVIEW {"approved":true,"note":"authorized decision supplied"}' }; };
      const startsBefore = architectureStarts + acceptanceStarts;
      await recoverTaskGraphNode(run.id, 'BOTH', 'implementation', 'stale-implementation-stamp');
      assert.equal(architectureStarts + acceptanceStarts, startsBefore, 'Admission commits readiness; only a later coordinator scan starts verification');
      assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status, 'verifying');
      for (let n = 0; n < 100; n++) {
        await runTaskGraphCycle(); const idle = new AbortController(); idle.abort(); await startTaskGraphCoordinator(idle.signal);
        if ((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status === 'passed') break;
      }
      assert.equal(architectureStarts + acceptanceStarts, startsBefore + 1, 'The admitted fixed candidate is reviewed exactly once');
      const resumed = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
      assert.equal(resumed.status, 'passed');
      assert.deepEqual(resumed.executions.map(job => executionProgress(job.dispatchMetadata)?.platformAttempts), budgets, 'Authorized review resume preserves retry budgets');
    }

    console.log(`Targeted ${mode}: reader ${readerStarts}, successful model ${modelStarts}, architecture ${architectureStarts}, acceptance ${acceptanceStarts}, successor ${nextStarts}, ${human ? 'one authorized human decision' : 'no human resume'}`);
  } finally { events.publishTaskRunEvent = publishEvent; checks.runSandboxedGraphCheck = runCheck; await prisma.taskGraphRun.delete({ where: { id: run.id } }); rmSync(root, { recursive: true, force: true }); }
}
async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  const modes = ['platform', 'architecture-platform', 'platform-exhausted', 'human', 'preparation', 'preparation-exhausted', 'integration-timeout', 'ownership', 'startup', 'startup-network'] as const;
  const selected = process.env.TASK_GRAPH_REVIEW_RETRY_CASE;
  if (selected && !modes.some(mode => mode === selected)) throw new Error(`Unknown review retry case: ${selected}`);
  try { for (const mode of modes) if (!selected || selected === mode) await scenario(mode); }
  finally { globalThis.fetch = original; await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
