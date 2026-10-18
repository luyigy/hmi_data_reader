import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { prepareGraphOutputForTask } from '../src/lib/task-graph/output-task-context';
import { archiveValidationResults } from '../src/lib/task-graph/validation-results';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prior-output-archive-'));
  const previous = process.env.TASK_GRAPH_VALIDATION_ROOT; process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'runtime');
  const parent = await prisma.task.create({ data: { name: 'prior output archive' } });
  const child = await prisma.task.create({ data: { name: 'own output consumer' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://archive-output', nodes: [{ key: 'A', goal: 'resource reuse', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: root, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
  try {
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, commit: 'a'.repeat(40) } });
    const first = await prepareGraphOutputForTask(child.id, 'first', []);
    await fs.mkdir(path.join(first.directory, 'ocr-models')); await fs.writeFile(path.join(first.directory, 'ocr-models/weights.bin'), 'frozen OCR weights');
    const originalEvent = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: job.nodeId, kind: 'output_runtime_prepared' } });
    const archive = await archiveValidationResults(job.nodeId, path.join(root, 'archive'));
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: job.nodeId, kind: 'validation_workspace_cleaned', idempotencyKey: 'archive-fixture', payload: { ...archive, deliveryCommits: [{ executionId: job.id, commit: 'a'.repeat(40) }] } } });
    const next = await prepareGraphOutputForTask(child.id, 'second', []);
    const prior: string[] = JSON.parse(next.env.AP_GRAPH_PRIOR_OUTPUTS_JSON);
    assert.equal(prior.length, 1, 'Cleanup must not erase the required prior OCR resource');
    assert.equal(await fs.readFile(path.join(prior[0], 'ocr-models/weights.bin'), 'utf8'), 'frozen OCR weights');
    assert.equal(next.priorArtifacts[0].eventId, originalEvent.id); assert.equal(next.priorArtifacts[0].originalDirectory, first.directory); assert.equal(next.priorArtifacts[0].archived, true);
    assert.ok(prior[0].startsWith(path.join(root, 'archive/files') + path.sep)); assert.notEqual(prior[0], first.directory);
    assert.deepEqual(next.readOnlyPaths, prior);
    assert.equal(await fs.access(first.directory).then(() => true, () => false), false, 'Lookup never restores old writable runtime');
    const injected = path.join(prior[0], 'ocr-models/unlisted.bin'); await fs.writeFile(injected, 'not in manifest');
    await assert.rejects(prepareGraphOutputForTask(child.id, 'injected-file', []), /unlisted/); await fs.unlink(injected);
    await fs.symlink(path.join(root, 'outside'), injected);
    await assert.rejects(prepareGraphOutputForTask(child.id, 'injected-link', []), /unlisted/); await fs.unlink(injected);
    await fs.writeFile(path.join(prior[0], 'ocr-models/weights.bin'), 'tampered');
    await assert.rejects(prepareGraphOutputForTask(child.id, 'third', []), /archive differs/);
    await fs.writeFile(path.join(prior[0], 'ocr-models/weights.bin'), 'frozen OCR weights');
    await fs.mkdir(path.join(first.directory, 'ocr-models'), { recursive: true });
    await fs.writeFile(path.join(first.directory, 'ocr-models/weights.bin'), 'different historical content');
    const conflicting = await archiveValidationResults(job.nodeId, path.join(root, 'second-archive'));
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: job.nodeId, kind: 'validation_workspace_cleaned', idempotencyKey: 'archive-conflicting-fixture', payload: { ...conflicting, deliveryCommits: [{ executionId: job.id, commit: 'b'.repeat(40) }] } } });
    await assert.rejects(prepareGraphOutputForTask(child.id, 'ambiguous', []), /archives disagree/, 'Two verified archives cannot silently assign different bytes to one original output event');
    console.log('Archived prior outputs retain original event identity and verified OCR bytes; missing live paths resolve read-only and corruption is refused');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } }); await prisma.$disconnect();
    if (previous === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
