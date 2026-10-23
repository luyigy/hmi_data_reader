import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { parseRuntimeDeclaration, runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { prepareDeclaredRuntime } from '../src/lib/task-graph/runtime-preflight';
import { hostRuntimeRegistration } from '../src/lib/task-graph/runtime-registration';
import { prepareTaskDeclaredRuntime } from '../src/lib/task-graph/runtime-continuity';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { executeViaLocalHarness } from '../src/lib/acpx/runner-harness';
import { getHarnessAdapter } from '../src/lib/harness';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../src/lib/acpx/permissions';
import { applyWorkflowPermissionSnapshot, buildWorkflowPermissionSnapshot } from '../src/lib/workflow-execution-policy';

const digest = '88173c650921e15528294eccd26e6f53d5cc37eb4f8e8035bfe4700c7a98d21d';
// This program executes inside each caller's actual Bubblewrap, against its stage-owned database.
const probe = `
const assert=require('node:assert/strict'),fs=require('node:fs');
const {PrismaClient}=require('@prisma/client');
const phase=process.argv[2], source=process.argv[3];
assert.equal(process.env.DATABASE_URL,undefined,'No host database credentials');
const connections=JSON.parse(process.env.TASK_GRAPH_SERVICES_JSON);
assert.equal(connections.length,1);
const service=connections[0];assert.equal(service.runtime,'postgres');
assert.equal(service.resource.sha256,'${digest}');
const client=new PrismaClient({datasources:{db:{url:service.url}}});
(async()=>{
  const [before]=await client.$queryRawUnsafe("SELECT to_regclass('public.s04_probe')::text AS existing");
  assert.equal(before.existing,null,'Each stage starts with clean data');
  await client.$executeRawUnsafe('CREATE TABLE s04_probe (marker text)');
  await client.$executeRawUnsafe('INSERT INTO s04_probe VALUES ($1)',phase);
  assert.deepEqual(await client.$queryRawUnsafe('SELECT marker FROM s04_probe'),[{marker:phase}]);
  if(phase==='implementation') fs.writeFileSync(source+'/implementation-write','allowed');
  else assert.throws(()=>fs.writeFileSync(source+'/source.txt','forbidden'),/EROFS|EACCES/);
  const [server]=await client.$queryRawUnsafe("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version");
  assert.match(server.version,/^14\\.24/);
  const result={phase,identity:process.env.AP_GRAPH_RUNTIME_IDENTITY,sha256:service.resource.sha256,directory:server.directory,port:new URL(service.url).port};
  fs.writeFileSync(process.env.AP_GRAPH_OUTPUT_DIR+'/s04-'+phase+'.json',JSON.stringify(result));
  console.log(JSON.stringify(result));
})().finally(()=>client.$disconnect()).catch(error=>{console.error(error);process.exitCode=1});
`;
async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await mkdtemp(path.join(tmpdir(), 'postgres-runtime-'));
  const repo = path.join(root, 'repo'), bundle = path.join(root, 'postgres'), output = path.join(root, 'output');
  const old = { runtime: process.env.TASK_GRAPH_RUNTIME_ROOT, validation: process.env.TASK_GRAPH_VALIDATION_ROOT, codex: process.env.CODEX_HOME };
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation'); process.env.CODEX_HOME = path.join(root, 'auth');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const adapter = getHarnessAdapter('codex')!; const originalExecute = adapter.execute;
  let runId: string | undefined, parentId: string | undefined;
  const tasks: string[] = [];
  let calls = 0;
  const reports: { phase: string; identity: string; sha256: string; directory: string; port: string }[] = [];
  try {
    await Promise.all([mkdir(repo), mkdir(output), mkdir(process.env.CODEX_HOME)]);
    await cp(path.resolve('.cache/sandbox-postgres/pg14.24.0'), bundle, { recursive: true, dereference: true });
    assert.equal(await runtimeResourceDigest(bundle), digest, 'Fixed archive bytes, not a newly approved cache digest');
    const declaration = { version: 1, postgres: { resource: { kind: 'path', path: bundle, sha256: digest } } };
    assert.deepEqual(parseRuntimeDeclaration(declaration), declaration);
    const registration = path.join(root, 'runtime-resources.json');
    await writeFile(registration, JSON.stringify({ [repo]: declaration }));
    assert.deepEqual(hostRuntimeRegistration(repo, registration)?.runtime, declaration);
    await writeFile(registration, JSON.stringify({ [repo]: { version: 1, postgres: { resource: { ...declaration.postgres.resource, path: 'relative-postgres' } } } }));
    assert.throws(() => hostRuntimeRegistration(repo, registration), /absolute independently approved paths/);
    for (const invalid of [
      { ...declaration, extra: true }, { ...declaration, postgres: { ...declaration.postgres, command: 'anything' } },
      { ...declaration, postgres: { resource: { ...declaration.postgres.resource, secret: true } } },
      { ...declaration, postgres: { resource: { kind: 'output', eventId: 'x', relativePath: 'db', sha256: digest } } },
    ]) assert.throws(() => parseRuntimeDeclaration(invalid));
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    await mkdir(path.join(repo, '.agent-platform'));
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(declaration));
    await writeFile(path.join(repo, 'source.txt'), 'protected source');
    await writeFile(path.join(repo, 'probe.cjs'), probe);
    await writeFile(path.join(repo, '.gitignore'), 'node_modules\nimplementation-write\n');
    await symlink(await realpath('node_modules'), path.join(repo, 'node_modules'));
    git('add', '.'); git('commit', '-m', 'Fixed PostgreSQL runtime'); const commit = git('rev-parse', 'HEAD');
    await assert.rejects(prepareDeclaredRuntime({ workspace: repo, approvedReadOnlyRoots: [], outputDirectory: output }), /超出已批准目录/);
    console.log('PASS declaration rejects unknown fields, output sources and unauthorized roots');
    const parent = await prisma.task.create({ data: { name: 'S04 PostgreSQL entrypoints' } }); parentId = parent.id;
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://s04', nodes: [{ key: 'DB', goal: 'DB', dependsOn: [], acceptance: { mode: 'automatic', checks: ['db'] }, executions: [{ key: 'app', repository: repo, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'db' }] }] } }); runId = run.id;
    await releaseReadyNodes(run.id); await claimNode(run.id, 'DB', 'claim-db');
    const job = await claimExecution(run.id, 'DB', 'app', 'claim-db'); assert(job);
    const worker = await createGraphWriter(); const taskId = `task-graph-${job.id}`;
    tasks.push(taskId); await prisma.task.create({ data: { id: taskId, name: 'S04 implementation' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: taskId, worktreePath: repo } });
    await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim-db', expectedRevision: 0, outcomeId: 'candidate', outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: commit, candidateCommit: commit, worker } });
    const permission = (workspace: string, readonly: boolean, roots: string[]) => ({ ...applyWorkflowPermissionSnapshot(DEFAULT_ACPX_PERMISSION_CONFIG, buildWorkflowPermissionSnapshot({ policy: { preset: 'workspace', extraReadOnlyPaths: roots, extraWritableRoots: [] }, projectPath: workspace, source: 's04-approved-fixture' })), sandboxMode: readonly ? 'read-only' as const : 'workspace-write' as const });
    adapter.execute = async ({ context }) => {
      calls++;
      const phase = context.permissionConfig?.sandboxMode === 'read-only' ? 'acceptance' : 'implementation';
      const env = { ...process.env, ...context.taskEnvironment, AP_TASK_SANDBOX: '1', HOME: '/tmp' };
      const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: [path.join(repo, 'probe.cjs'), phase, repo], cwd: context.workingDirectory!, workspaceRoot: context.workspaceRoot!, sandboxMode: context.permissionConfig?.sandboxMode, networkAccess: 'enabled', env, readOnlyPaths: context.extraReadOnlyPaths, writableRoots: context.extraWritableRoots });
      const result = await promisify(execFile)(wrapped.command, wrapped.args, { env, timeout: 30_000 });
      reports.push(JSON.parse(result.stdout.trim()));
      return { success: true, output: result.stdout, executionTime: 1 };
    };
    const native = async (id: string, cwd: string, readonly: boolean, roots: string[]) => {
      const nativeRun = await prisma.taskRun.create({ data: { taskId: id, status: 'running', mode: 'acpx', controlMetadata: JSON.stringify({ graphWriter: worker }), participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: readonly ? 'tester' : 'implementer', status: 'running' } } }, include: { participants: true } });
      return executeViaLocalHarness({ taskId: id, taskName: 'S04 database', workingDirectory: cwd, permissionConfig: permission(cwd, readonly, roots), orchestrationMode: 'single', participants: [] }, nativeRun.id, nativeRun.participants[0].id, { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: readonly ? 'tester' : 'implementer' }, {}, [], { transcript: '', latestUserMessage: null });
    };
    await native(taskId, repo, false, [bundle]);
    const pin = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId, kind: 'runtime_snapshot_pinned' } });
    assert.equal((await readFile(path.join(repo, 'implementation-write'), 'utf8')), 'allowed');
    console.log('PASS implementation entry runs real SQL in Bubblewrap with approved fixed resource');
    const check = await runSandboxedGraphCheck([process.execPath, path.join(repo, 'probe.cjs'), 'check', repo], repo, { AP_GRAPH_SERVICE_TASK_ID: taskId, AP_GRAPH_WRITER_NONCE: worker.nonce });
    reports.push(JSON.parse(check.stdout.trim()));
    console.log('PASS platform check entry runs SQL and protects source writes');
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const progress = executionProgress(current.dispatchMetadata); assert(progress);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, dispatchMetadata: metadataWithProgress(current.dispatchMetadata, { ...progress, phase: 'acceptance', revision: progress.revision + 1 }) } });
    const review = path.join(root, 'review'); await mkdir(review);
    const reviewTask = `task-graph-review-${job.nodeId}`; tasks.push(reviewTask); await prisma.task.create({ data: { id: reviewTask, name: 'S04 acceptance' } });
    await native(reviewTask, review, true, [repo, bundle]);
    assert.equal(await readFile(path.join(repo, 'source.txt'), 'utf8'), 'protected source');
    assert.equal(new Set(reports.map(item => item.identity)).size, 1);
    assert.equal(new Set(reports.map(item => item.sha256)).size, 1);
    assert.equal(new Set(reports.map(item => item.directory)).size, 3);
    assert.deepEqual(reports.map(item => item.phase), ['implementation', 'check', 'acceptance']);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId, kind: 'runtime_snapshot_pinned' } }), 1);
    assert.deepEqual((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: pin.id } })).payload, pin.payload);
    console.log('PASS independent acceptance uses identical claim pin and fresh database; source stays readonly');
    await assert.rejects(native(reviewTask, review, true, [repo]), /超出已批准目录/);
    const drift = path.join(bundle, 'share/postgresql/s04-drift'); await writeFile(drift, 'mutated');
    await assert.rejects(native(reviewTask, review, true, [repo, bundle]), /SHA256/);
    await assert.rejects(runSandboxedGraphCheck([process.execPath, '-e', 'throw Error("must not run")'], repo, { AP_GRAPH_SERVICE_TASK_ID: taskId, AP_GRAPH_WRITER_NONCE: worker.nonce }), /SHA256/);
    await rm(drift);
    assert.equal(calls, 2, 'Denied or mutated resources never reach model adapter');
    console.log('PASS acceptance denies narrower grants; both entrypoints reject resource drift before execution');
    const closed = await prisma.taskGraphEvent.findMany({ where: { runId, kind: 'service_attempt_closed' } });
    assert.equal(closed.length, 3);
    for (const event of closed) {
      const payload = JSON.parse(JSON.stringify(event.payload));
      assert.equal(payload.failureNote, null);
      assert.equal(payload.receipts[0].closed, true);
      assert.deepEqual(await readdir(payload.directory), ['receipt.json']);
      const { PrismaClient } = await import('@prisma/client');
      const client = new PrismaClient({ datasources: { db: { url: `postgresql://postgres:invalid@127.0.0.1:${payload.receipts[0].port}/postgres?connect_timeout=1` } } });
      try { await assert.rejects(client.$connect(), /Can't reach database server/); } finally { await client.$disconnect(); }
    }
    // Changing a versioned declaration cannot replace the current claim pin.
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify({ version: 1 })); git('add', '.'); git('commit', '-m', 'Changed runtime requires new claim');
    await assert.rejects(prepareTaskDeclaredRuntime({ taskId, workspace: repo, approvedReadOnlyRoots: [bundle], outputDirectory: output }), /候选|改变/);
    console.log('PASS all three stages close their ports and remove data; changed declaration cannot reuse claim');
  } finally {
    adapter.execute = originalExecute;
    if (runId) await prisma.taskGraphRun.delete({ where: { id: runId } });
    await prisma.task.deleteMany({ where: { id: { in: tasks } } }); if (parentId) await prisma.task.delete({ where: { id: parentId } });
    await prisma.$disconnect();
    for (const [name, value] of [['TASK_GRAPH_RUNTIME_ROOT', old.runtime], ['TASK_GRAPH_VALIDATION_ROOT', old.validation], ['CODEX_HOME', old.codex]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; }
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
