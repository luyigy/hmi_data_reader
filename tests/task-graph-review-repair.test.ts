import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function scenario(mode: 'architecture' | 'integration' | 'acceptance' | 'invalid') {
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
  const definition: GraphDefinition = { specRef: 'fixture://targeted-review', nodes: [{ key: 'BOTH', goal: 'joint behavior', dependsOn: [], executionMode: mode === 'architecture' ? 'full' : 'lean',
    ...(mode === 'architecture' ? { architectureReview: { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: reviewer } } } : {}),
    acceptance: { mode: mode === 'integration' ? 'automatic' : 'agent', reviewerId: 'local:kimi-code', checks: ['joint'], reviewLaunchConfig: { participant: reviewer },
      integrationChecks: [{ name: 'joint', repository: repositories[0].repository, argv: ['python3', '-c', 'from pathlib import Path; import os; Path(os.environ["AP_GRAPH_OUTPUT_DIR"],"joint-proof.txt").write_text("checked"); assert Path("value").read_text() == '+JSON.stringify(mode === 'integration' ? 'good' : 'bad')+' or Path("value").read_text()=="good"'] }] },
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
    if (mode === 'invalid') return { success: true, output: `${marker} {"approved":false,"note":"bad identity","failureKind":"in_scope_defect","failureKey":"unknown","executionIds":["other-node"]}`, executionTime: 1 };
    if (readerStarts === 1 && (mode === 'architecture' && architecture || mode === 'acceptance' && !architecture)) {
      if (mode === 'acceptance' && acceptanceStarts === 1) return { success: true, output: `${marker} {"approved":false,"note":"wrong check identity","failureKind":"in_scope_defect","failureKey":"joint","executionIds":["${reader.id}"]}`, executionTime: 1 };
      return { success: true, output: `${marker} ${JSON.stringify({ approved: false, note: 'reader defect within approved scope', failureKind: 'in_scope_defect', failureKey: architecture ? 'architecture:scope' : 'acceptance:joint', executionIds: [reader.id] })}`, executionTime: 1 };
    }
    return { success: true, output: `${marker} {"approved":true,"note":"joint behavior checked"}`, executionTime: 1 };
  };
  try {
    for (let n = 0; n < 600; n++) {
      await runTaskGraphCycle();
      const status = (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status;
      if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed' || mode === 'invalid' && status === 'attention') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    const after = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id }, include: { executions: true } });
    if (mode === 'invalid') {
      assert.equal(after.status, 'attention');
      assert.ok(after.executions.every(job => executionProgress(job.dispatchMetadata)?.state === 'exhausted'));
      assert.ok(after.executions.every(job => job.commit && job.evidence), 'Protocol escalation retains all delivered commits and evidence');
      assert.equal(acceptanceStarts, 2); assert.equal(readerStarts, 1);
      assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'review_result_exhausted' } }), 1);
    } else {
      assert.equal(after.status, 'passed', JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'desc' }, take: 10 })));
      assert.equal(nextStarts, 1, 'Passed repaired Slice automatically dispatches its successor');
      assert.equal(readerStarts, 2); assert.equal(modelStarts, 1, 'Successful sibling Agent never starts during repair');
      if (mode === 'architecture') assert.equal(architectureStarts, 2, 'Changed candidate combination reruns architecture review');
      if (mode === 'acceptance') { assert.equal(acceptanceStarts, 3); assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'review_result_recollection' } }), 1); }
      const sibling = after.executions.find(job => job.key === 'model')!;
      if (modelCommit) { assert.equal(sibling.commit, modelCommit); assert.deepEqual(sibling.evidence, modelEvidence); }
      const repairs = await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } });
      assert.equal(repairs.length, 1); assert.deepEqual((repairs[0].payload as { executionIds: string[] }).executionIds, [reader.id]);
      const archived = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'validation_workspace_cleaned' } });
      const payload = archived.payload as { directory: string };
      const manifest = JSON.parse(readFileSync(path.join(payload.directory, 'manifest.json'), 'utf8'));
      assert.equal(manifest.files.filter((file: { path: string }) => file.path.endsWith('joint-proof.txt')).length, 2, 'Joint contract reruns for repaired combination');
    }
    console.log(`Targeted ${mode}: reader ${readerStarts}, successful model ${modelStarts}, architecture ${architectureStarts}, acceptance ${acceptanceStarts}, successor ${nextStarts}, no human resume`);
  } finally { await prisma.taskGraphRun.delete({ where: { id: run.id } }); rmSync(root, { recursive: true, force: true }); }
}
async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  try { for (const mode of ['architecture', 'integration', 'acceptance', 'invalid'] as const) await scenario(mode); }
  finally { globalThis.fetch = original; await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
