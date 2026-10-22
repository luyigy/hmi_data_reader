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
import { executionProgress } from '../src/lib/task-graph/execution-progress';
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
  const original = adapter.execute;
  adapter.execute = async ({ task, context }) => {
    const key = task.name.split(' · ')[0]; const count = (calls.get(key) || 0) + 1; calls.set(key, count);
    if (key === 'C' || key === 'D') {
      const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: task.id }, orderBy: { createdAt: 'desc' } });
      const latest = await prisma.taskRunEvent.findFirst({ where: { taskRunId: turn.id }, orderBy: { sequence: 'desc' } });
      await prisma.taskRunEvent.create({ data: { taskRunId: turn.id, sequence: (latest?.sequence || 0) + 1, eventType: 'control_message',
        content: `工具：Bash · write evidence/${turn.id}/resume-receipt.json; check missing skills`, metadata: JSON.stringify({ kind: 'tool', toolName: 'Bash' }) } });
    }
    const value = 'fixed';
    writeFileSync(path.join(context.workingDirectory!, `${key}.txt`), value);
    if (key === 'D') return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"required skills missing","evidence":["resume-receipt.json"]}', executionTime: 1 };
    if (key === 'A' && count === 1 || key === 'C') return { success: true, output: 'No delivery conclusion', executionTime: 1 };
    if (key === 'A' && count === 2) assert.match(task.description || '', /Implement A/);
    return { success: true, output: `TASK_GRAPH_IMPLEMENTATION ${JSON.stringify({ status: 'delivered', note: `${key} implemented`, evidence: [`${key}.txt`] })}`, executionTime: 1 };
  };
  const parent = await prisma.task.create({ data: { name: 'automatic repair fixture' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://automatic-repair', nodes: ['A', 'B', 'C', 'D'].map(key => ({
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
    for (let i = 0; i < 350; i++) {
      await runTaskGraphCycle();
      const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, select: { key: true, status: true } });
      assert.ok(!nodes.some(node => node.key === 'A' && node.status === 'attention'));
      if (nodes.every(node => ['C', 'D'].includes(node.key) ? node.status === 'attention' : node.status === 'passed')) { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(completed, 'The original ticket, successor and independent branch must finish without human resume');
    assert.equal(calls.get('A'), 2); assert.equal(calls.get('B'), 1); assert.equal(calls.get('C'), maxUnchangedWorkTurns + 1);
    assert.equal(calls.get('D'), maxUnchangedWorkTurns + 1, 'Malformed blocked receipts with fresh evidence paths stop instead of spinning');
    const invalid = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'D' } } });
    assert.equal(executionProgress(invalid.dispatchMetadata)?.lastFailure?.code, 'invalid_result');
    assert.equal(invalid.commit, null);
    const waiting = await prisma.taskGraphExecution.findFirstOrThrow({where:{node:{runId:run.id,key:'C'}}});
    assert.equal(executionProgress(waiting.dispatchMetadata)?.state, 'waiting_for_user');
    assert.equal(executionProgress(waiting.dispatchMetadata)?.formatAttempts, 0); assert.equal(waiting.commit, null);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: { in: ['conversation_review_recovery_requested', 'implementation_recovery_scheduled'] } } }), 0);
    console.log('Real coordinator: ordinary output continues implementation; repeated unchanged work waits without fake delivery or revoked approval; independent successor passes; human resume0');
  } finally {
    await drain(); adapter.execute = original;
    const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } }, select: { childTaskId: true } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, ...jobs.flatMap(job => job.childTaskId ? [job.childTaskId] : [])] } } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
