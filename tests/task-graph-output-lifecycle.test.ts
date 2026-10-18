import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const root = mkdtempSync(path.join(tmpdir(), 'graph-output-lifecycle-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  mkdirSync(path.join(repository, '.agent-platform'));
  writeFileSync(path.join(repository, '.agent-platform/outputs.json'), JSON.stringify({ version: 1, paths: ['output/job'] }));
  writeFileSync(path.join(repository, '.gitignore'), 'output/\n.venv/\n');
  writeFileSync(path.join(repository, 'probe.py'), 'import os, pathlib, sqlite3\np=pathlib.Path(__file__).parent\nos.chdir(p)\n(p/"output/job/report.json").write_text("report")\no=pathlib.Path(os.environ["AP_GRAPH_OUTPUT_DIR"])\n(o/"proof.txt").write_text("stage proof")\ndb=sqlite3.connect(o/"test.sqlite")\ndb.execute("pragma journal_mode=wal")\ndb.execute("create table if not exists t(v)")\ndb.execute("insert into t values(1)")\ndb.commit()\nprint(o)\n');
  execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(repository, '.venv')]);
  git('add', '.'); git('commit', '-m', 'output fixture'); const commit = git('rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'harness'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const reviewer = { ...participant, harnessType: 'kimi-code', role: 'tester' };
  const directories: string[] = [];
  let jobDirectory = '';
  getHarnessAdapter('codex')!.execute = async ({ context }) => {
    jobDirectory = context.workingDirectory!;
    const env: NodeJS.ProcessEnv = { ...process.env, ...context.taskEnvironment, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0' };
    const wrapped = wrapWithBubblewrap({ command: 'python3', commandArgs: ['probe.py'], cwd: jobDirectory, workspaceRoot: context.workspaceRoot, readOnlyPaths: context.extraReadOnlyPaths, env });
    directories.push(execFileSync(wrapped.command, wrapped.args, { env, encoding: 'utf8' }).trim());
    writeFileSync(path.join(jobDirectory, 'implemented.txt'), 'implemented');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"reports and database checked","evidence":["proof.txt"]}', executionTime: 1 };
  };
  getHarnessAdapter('kimi-code')!.execute = async ({ context }) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...context.taskEnvironment, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0' };
    assert.notEqual(env.AP_GRAPH_OUTPUT_DIR, directories[0]);
    const wrapped = wrapWithBubblewrap({ command: 'python3', commandArgs: [path.join(jobDirectory, 'probe.py')], cwd: context.workingDirectory!, workspaceRoot: context.workspaceRoot, readOnlyPaths: context.extraReadOnlyPaths, env });
    directories.push(execFileSync(wrapped.command, wrapped.args, { env, encoding: 'utf8' }).trim());
    const prior = JSON.parse(context.taskEnvironment!.AP_GRAPH_PRIOR_OUTPUTS_JSON);
    assert.ok(prior.includes(directories[0]));
    const proof = path.join(directories[0], 'proof.txt');
    const writableCwd = wrapWithBubblewrap({ command: 'sh', commandArgs: ['-c', 'echo runtime > cwd-proof.txt'], cwd: context.workingDirectory!, workspaceRoot: context.workspaceRoot, readOnlyPaths: context.extraReadOnlyPaths, env });
    execFileSync(writableCwd.command, writableCwd.args, { env });
    const readPrior = wrapWithBubblewrap({ command: 'sh', commandArgs: ['-c', 'cat "$1"; ! echo corrupt > "$1"', 'sh', proof], cwd: context.workingDirectory!, workspaceRoot: context.workspaceRoot, readOnlyPaths: context.extraReadOnlyPaths, env });
    assert.match(execFileSync(readPrior.command, readPrior.args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /stage proof/);
    assert.equal(readFileSync(proof, 'utf8'), 'stage proof');
    assert.equal(existsSync(path.join(jobDirectory, '.venv')), false);
    return { success: true, output: 'TASK_GRAPH_REVIEW {"approved":true,"note":"same command writes isolated reports with readonly source"}', executionTime: 1 };
  };
  const parent = await prisma.task.create({ data: { name: 'output lifecycle' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://outputs', nodes: [{ key: 'OUTPUT', goal: 'reports', dependsOn: [], executionMode: 'lean', acceptance: { mode: 'agent', reviewerId: 'local:kimi-code', checks: ['reports'], reviewLaunchConfig: { participant: reviewer } }, executions: [{ key: 'job', repository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'reports', launchConfig: { participant, checks: [{ name: 'reports', argv: ['python3', 'probe.py'] }] } }] }] } });
  try {
    for (let n = 0; n < 400; n++) {
      await runTaskGraphCycle();
      const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'OUTPUT' } } });
      if (node.status === 'passed') break;
      if (node.status === 'attention') throw new Error(JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { runId: run.id }, take: 8, orderBy: { createdAt: 'desc' } })));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'OUTPUT' } } })).status, 'passed');
    assert.equal(new Set(directories).size, 2);
    const receipts = await prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: 'output_runtime_prepared' } });
    assert.equal(receipts.length, 3, 'Implementation, platform check and independent acceptance persist distinct runtime receipts');
    const archive = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId: run.id, kind: 'validation_workspace_cleaned' } });
    const payload = archive.payload;
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.directory === 'string');
    const files: string[] = [];
    const walk = (directory: string) => { for (const item of readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) walk(file); else files.push(file); } }; walk(payload.directory);
    assert.equal(files.filter(file => path.basename(file) === 'proof.txt').length, 3);
    assert.equal(git('status', '--porcelain'), ''); assert.equal(git('rev-parse', 'HEAD'), commit);
    console.log('Real Git + isolated PostgreSQL + Bubblewrap: same report/SQLite command succeeds in implementation, readonly platform check and independent acceptance, then all three outputs archive');
  } finally {
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    globalThis.fetch = realFetch;
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
