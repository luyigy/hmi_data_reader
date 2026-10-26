import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRuntimeDeclaration, runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { prepareDeclaredRuntime, assertRuntimeResourcesUnchanged } from '../src/lib/task-graph/runtime-preflight';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { prepareTaskDeclaredRuntime } from '../src/lib/task-graph/runtime-continuity';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { getHarnessAdapter } from '../src/lib/harness';
import { executeViaLocalHarness } from '../src/lib/acpx/runner-harness';
import { hostRuntimeRegistration } from '../src/lib/task-graph/runtime-registration';

async function verifyClaim(repository: string, root: string, roots: string[]) {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const platform = path.join(root, 'platform'), review = path.join(root, 'review'), output = path.join(root, 'claim-output');
  for (const dir of [path.join(platform, 'config'), review, output]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(platform, 'config/runtime-environments.json'), JSON.stringify({ [repository]: roots }));
  const parent = await prisma.task.create({ data: { name: 'Project-owned runtime claim' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    deliveryContract: 'agent_owned_v1', specRef: 'fixture://project-runtime', nodes: [{ key: 'A', goal: 'project validation', dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: ['project environment'] }, executions: [{ key: 'job', repository, baseCommit: commit, gitRef: 'refs/heads/main', agentSelector: 'local:codex', instructions: 'validate project' }] }],
  } });
  await releaseReadyNodes(run.id); await claimNode(run.id, 'A', 'claim-A');
  const job = await claimExecution(run.id, 'A', 'job', 'claim-A'); assert(job);
  const task = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'Project runtime' } });
  try {
    const worker = await createGraphWriter();
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: task.id, worktreePath: repository } });
    await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim-A', expectedRevision: 0, outcomeId: 'candidate',
      outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: commit, candidateCommit: commit, worker } });
    const prepared = await prepareTaskDeclaredRuntime({ platformRepository: platform, taskId: task.id, workspace: repository, outputDirectory: output, approvedReadOnlyRoots: [] });
    const nativeRun = await prisma.taskRun.create({ data: { taskId: task.id, status: 'running', mode: 'acpx', controlMetadata: JSON.stringify({ graphWriter: worker }),
      participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer', status: 'running' } } }, include: { participants: true } });
    const adapter = getHarnessAdapter('codex')!, original = adapter.execute;
    let starts = 0;
    adapter.execute = async ({ task: nativeTask, context }) => {
      starts++;
      assert.equal(context.taskEnvironment?.AP_GRAPH_RUNTIME_RESOURCES_JSON, prepared.env.AP_GRAPH_RUNTIME_RESOURCES_JSON);
      assert.equal(context.taskEnvironment?.AP_GRAPH_RUNTIME_VALIDATION_JSON, prepared.env.AP_GRAPH_RUNTIME_VALIDATION_JSON);
      assert.match(nativeTask.description || '', /environmentFingerprint/);
      return { success: true, output: 'fixture inspected project-owned validation instructions', executionTime: 1 };
    };
    try {
      await executeViaLocalHarness({ taskId: task.id, taskName: task.name, workingDirectory: repository, orchestrationMode: 'single', participants: [] },
        nativeRun.id, nativeRun.participants[0].id, { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, {}, [], { transcript: '', latestUserMessage: null });
    } finally { adapter.execute = original; }
    assert.equal(starts, 1);
    const row = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const progress = executionProgress(row.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, dispatchMetadata: metadataWithProgress(row.dispatchMetadata, { ...progress, phase: 'acceptance' }) } });
    const args = { platformRepository: platform, taskId: `task-graph-review-${job.nodeId}`, workspace: review, approvedReadOnlyRoots: [repository], outputDirectory: output };
    const reviewed = await prepareTaskDeclaredRuntime(args);
    assert.equal(reviewed.identity, prepared.identity);
    assert.deepEqual(reviewed.receipt?.validation, prepared.receipt?.validation);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'runtime_probes_verified' } }), 0, 'New declarations never execute legacy probes');
    const pin = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId: run.id, kind: 'runtime_snapshot_pinned' } });
    const advanced = 'f'.repeat(40);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { commit: advanced, dispatchMetadata: metadataWithProgress(row.dispatchMetadata, { ...progress, phase: 'acceptance', candidateCommit: advanced }) } });
    await assert.rejects(prepareTaskDeclaredRuntime(args), /当前候选/, 'Matching resources cannot validate a wrong source candidate');
    assert.deepEqual((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: pin.id } })).payload, pin.payload);
    console.log('PASS v2 native launch and non-Git review retain claim/permissions/argv; wrong candidate rejected, zero platform probes');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: task.id } }); await prisma.task.delete({ where: { id: parent.id } });
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-runtime-'));
  try {
    for (const project of ['model', 'browser']) {
      const repository = path.join(root, project), output = path.join(root, project + '-output');
      const shared = path.join(root, project + '-dependencies'), denied = path.join(root, project + '-private');
      for (const dir of [path.join(repository, '.agent-platform'), output, shared, denied]) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(denied, 'secret'), 'unapproved data');
      await fs.writeFile(path.join(shared, 'version'), project === 'model' ? 'weights-v3' : 'controller-v7');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
      git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
      // Domain knowledge belongs only to this fixture script. Preparation must never execute it.
      const script = `const fs=require('fs'),path=require('path'),crypto=require('crypto');
const r=JSON.parse(process.env.AP_GRAPH_RUNTIME_RESOURCES_JSON);
const expected=${JSON.stringify(project === 'model' ? 'weights-v3' : 'controller-v7')};
if(fs.readFileSync(path.join(r.dependencies,'version'),'utf8')!==expected)throw Error('project dependency version mismatch: '+expected);
if(process.argv.includes('--missing'))throw Error('missing ${project === 'model' ? 'OCR model loader' : 'browser controller'} dependency');
for(const file of [path.join(r.dependencies,'write'),path.join(process.cwd(),'source-write')]){
 let refused=false;try{fs.writeFileSync(file,'forbidden')}catch(e){refused=true}if(!refused)throw Error('writable protected input: '+file);
}
try{fs.readFileSync(${JSON.stringify(path.join(denied, 'secret'))});throw Error('private path exposed')}catch(e){if(e.message==='private path exposed')throw e}
const environment={runtime:process.env.AP_GRAPH_RUNTIME_IDENTITY,interpreter:process.execPath,version:process.version,dependency:expected};
fs.appendFileSync(path.join(process.env.AP_GRAPH_OUTPUT_DIR,'executions'),'once\\n');
console.log(JSON.stringify({environment,environmentFingerprint:crypto.createHash('sha256').update(JSON.stringify(environment)).digest('hex')}));`;
      await fs.writeFile(path.join(repository, 'verify.cjs'), script);
      const interpreter = await fs.realpath(process.execPath);
      const declaration = { version: 2, resources: [
        { id: 'interpreter', resource: { path: interpreter, sha256: await runtimeResourceDigest(interpreter) } },
        { id: 'script', resource: { path: 'verify.cjs', sha256: await runtimeResourceDigest(path.join(repository, 'verify.cjs')) } },
        { id: 'dependencies', resource: { path: shared, sha256: await runtimeResourceDigest(shared) } },
      ], validation: { interpreter: 'interpreter', script: 'script', args: [] } };
      assert.equal(parseRuntimeDeclaration(declaration).version, 2);
      for (const invalid of [
        { ...declaration, browser: {} }, { ...declaration, resources: [...declaration.resources, declaration.resources[0]] },
        { ...declaration, validation: { ...declaration.validation, script: 'missing' } },
        { ...declaration, validation: { ...declaration.validation, timeout: 0 } },
        { ...declaration, resources: [{ ...declaration.resources[0], writable: true }] },
      ]) assert.throws(() => parseRuntimeDeclaration(invalid));
      const save = async () => { await fs.writeFile(path.join(repository, '.agent-platform/runtime.json'), JSON.stringify(declaration)); git('add', '.'); git('commit', '-m', 'fixed project environment'); };
      await save();
      const args = { workspace: repository, approvedReadOnlyRoots: [interpreter, shared], outputDirectory: output };
      await assert.rejects(prepareDeclaredRuntime({ ...args, approvedReadOnlyRoots: [interpreter] }), /已批准目录/);
      const prepared = await prepareDeclaredRuntime(args);
      assert.equal(prepared.receipt?.commit, git('rev-parse', 'HEAD'));
      assert.equal(prepared.receipt?.validation?.owner, 'agent');
      assert.deepEqual(prepared.receipt?.validation?.argv, [interpreter, path.join(repository, 'verify.cjs')]);
      assert.match(prepared.instructions, /实施者|Agent/);
      assert.match(prepared.instructions, /environmentFingerprint/);
      assert.equal(await fs.stat(path.join(output, 'executions')).catch(() => null), null);
      const execute = (extra: string[] = []) => {
        const argv = prepared.receipt!.validation!.argv;
        const env = { ...process.env, ...prepared.env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0',
          AP_GRAPH_OUTPUT_DIR: output, AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: output, target: output, readOnly: false }]) };
        const wrapped = wrapWithBubblewrap({ command: argv[0], commandArgs: [...argv.slice(1), ...extra], cwd: repository, workspaceRoot: repository,
          sandboxMode: 'read-only', networkAccess: 'restricted', strictReadOnlyRoots: true, readOnlyPaths: prepared.readOnlyPaths, env });
        return execFileSync(wrapped.command, wrapped.args, { cwd: repository, env, timeout: 20_000, encoding: 'utf8', stdio: 'pipe' });
      };
      const result = JSON.parse(execute());
      assert.equal(result.environment.interpreter, interpreter);
      assert.match(result.environmentFingerprint, /^[a-f0-9]{64}$/);
      console.log(JSON.stringify({ project, declarationCommit: prepared.receipt?.commit, manifestHash: prepared.manifestHash,
        runtimeIdentity: prepared.identity, argv: prepared.receipt?.validation?.argv, ...result }));
      await prepareDeclaredRuntime(args); await prepareDeclaredRuntime(args);
      assert.equal(await fs.readFile(path.join(output, 'executions'), 'utf8'), 'once\n', 'Preparation never repeats project validation');
      assert.throws(() => execute(['--missing']), /missing .* dependency/, 'Project reports its own missing dependency');
      if (project === 'model') await verifyClaim(repository, root, [path.dirname(interpreter), shared]);
      assert.equal(await fs.readFile(path.join(output, 'executions'), 'utf8'), 'once\n');
      const registration = path.join(root, 'registration.json');
      await fs.writeFile(registration, JSON.stringify({ [repository]: declaration }));
      assert.throws(() => hostRuntimeRegistration(repository, registration), /absolute/, 'Host registration cannot smuggle a relative project script');
      await fs.writeFile(path.join(repository, 'verify.cjs'), script + '\n// wrong source bytes');
      await assert.rejects(prepareDeclaredRuntime(args), /SHA256/);
      await fs.writeFile(path.join(repository, 'verify.cjs'), script);
      await fs.writeFile(path.join(shared, 'version'), 'wrong version');
      await assert.rejects(prepareDeclaredRuntime(args), /SHA256/);
      await assert.rejects(assertRuntimeResourcesUnchanged(prepared.verifiedResources), /改变/);
      console.log(`PASS ${project}: pinned script/interpreter, sandboxed Agent validation once, clear dependency error, permission and byte drift rejected`);
    }
  } finally { await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
