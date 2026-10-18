import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { parseImplementationResult } from '../src/lib/task-graph/implementation-result';
import { getHarnessAdapter } from '../src/lib/harness';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  assert.throws(() => parseImplementationResult('TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing","blockerKind":"environment_failed","blockerCause":"guess"}'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-environment-outcome-')), repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'fixture@example.test');
  await fs.writeFile(path.join(repository, 'base'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename); const notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const fetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const parent = await prisma.task.create({ data: { name: 'environment outcomes' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://environment', nodes: ['MISSING', 'TRANSIENT', 'EXHAUST'].map(key => ({
    key, goal: key, dependsOn: [], executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['candidate'] },
    executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: key,
      launchConfig: { participant, checks: [{ name: 'candidate', argv: ['test', '-f', `${key}.txt`] }] } }],
  })) } });
  const starts = new Map<string, number>();
  getHarnessAdapter('codex')!.execute = async ({ task, context }) => {
    const key = task.name.split(' · ')[0], count = (starts.get(key) || 0) + 1; starts.set(key, count);
    await fs.writeFile(path.join(context.workingDirectory!, `${key}.txt`), 'saved candidate');
    const result = key === 'TRANSIENT' && count > 1 ? { status: 'delivered', note: 'recovered', evidence: ['candidate'] }
      : { status: 'blocked', blockerKind: 'environment_failed', note: 'runtime preparation failed', ...(key === 'MISSING' ? {} : { blockerCause: 'transient' }) };
    return { success: true, executionTime: 1, output: `TASK_GRAPH_IMPLEMENTATION ${JSON.stringify(result)}` };
  };
  try {
    for (let n = 0; n < 300; n++) {
      await runTaskGraphCycle();
      const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id } });
      if (nodes.find(node => node.key === 'TRANSIENT')?.status === 'passed' && starts.get('EXHAUST') === 3) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } }, include: { node: true } });
    const missing = jobs.find(job => job.node.key === 'MISSING')!, exhausted = jobs.find(job => job.node.key === 'EXHAUST')!;
    assert.equal(starts.get('MISSING'), 1, 'Undeclared environment failure must not rerun native implementation in unchanged environment');
    assert.equal(missing.status, 'attention'); assert.equal(executionProgress(missing.dispatchMetadata)?.platformAttempts, 0);
    assert.equal(executionProgress(missing.dispatchMetadata)?.lastFailure?.owner, 'platform'); assert.equal(executionProgress(missing.dispatchMetadata)?.lastFailure?.requiresUserDecision, false);
    assert.match(executionProgress(missing.dispatchMetadata)?.lastFailure?.action || '', /准备并验证/);
    assert.equal(starts.get('TRANSIENT'), 2); assert.equal(jobs.find(job => job.node.key === 'TRANSIENT')?.node.status, 'passed');
    assert.equal(starts.get('EXHAUST'), 3); assert.equal(executionProgress(exhausted.dispatchMetadata)?.state, 'exhausted');
    assert.equal(executionProgress(exhausted.dispatchMetadata)?.platformAttempts, 2);
    console.log('Unknown environment failure: one native start and platform preparation action; typed transient retries recover or exhaust after two retries');
  } finally { globalThis.fetch = fetch; await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
