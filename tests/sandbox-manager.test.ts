import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { withSandbox } from '../src/lib/sandbox-manager';
import { transpileModule, ModuleKind } from 'typescript';
import { performance } from 'node:perf_hooks';
import { runSandboxScope, SandboxScopeError, type ManagedSandboxProcess, type SandboxBackend } from '../src/lib/sandbox-manager/lifecycle';
import { captureSandboxIdentity } from '../src/lib/sandbox-manager/identity';
import { clearRunningProcess, getRunningProcess, registerRunningProcess, requestRunControl, consumeRunControlRequest } from '../src/lib/acpx/process-registry';

const ready = async (child: ReturnType<typeof spawn>) => { await once(child.stdout!, 'data'); };
const backend = (script: string, overrides: Partial<SandboxBackend> = {}): SandboxBackend => ({
  start: () => spawn(process.execPath, ['-e', script], { stdio: 'pipe' }),
  captureIdentity: captureSandboxIdentity,
  cleanup: async () => {},
  ...overrides,
});
const live = "process.stdout.write('ready');setInterval(()=>{},1000)";
const ignored = "process.on('SIGTERM',()=>{});" + live;
async function main() {
  if (process.env.S01_TEST_BASELINE === '1') {
    const source = execFileSync('git', ['show', 'c1a8399:src/lib/acpx/process-registry.ts'], {encoding:'utf8'});
    const module = {exports: {clearRunningProcess, getRunningProcess, registerRunningProcess, requestRunControl}};
    new Function('require','module','exports', transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS}}).outputText)(createRequire(path.join(process.cwd(),'src/lib/acpx/process-registry.ts')),module,module.exports);
    const child = spawn(process.execPath,['-e',ignored],{stdio:'pipe'});
    try {
      await ready(child);
      module.exports.registerRunningProcess({taskRunId:'baseline',participantId:'baseline',child,executionBackend:'local',harnessType:'codex'});
      child.kill('SIGTERM');
      module.exports.clearRunningProcess('baseline');
      assert.ok(module.exports.getRunningProcess('baseline'), 'A baseline loses live control registration after TERM request + participant clear');
    } finally { const closed = once(child,'close'); child.kill('SIGKILL'); await closed; }
    return;
  }
  let prematureCleanup = false;
  await runSandboxScope(backend("process.exit(0)", {cleanup: async () => {prematureCleanup = true;}}), async ({child}) => {
    await once(child,'close'); assert.equal(prematureCleanup, false);
  });
  assert.equal(prematureCleanup, true);
  const workspace = mkdtempSync(path.join(tmpdir(),'s01-managed-'));
  try {
    const output = await withSandbox({command:'/usr/bin/printf',commandArgs:['managed-bwrap'],cwd:workspace,workspaceRoot:workspace,env:process.env}, async ({child}) => {
      let text = ''; child.stdout!.on('data', chunk => {text += chunk;});
      const [code] = await once(child,'close'); assert.equal(code,0); return text;
    });
    assert.equal(output,'managed-bwrap');
  } finally { rmSync(workspace,{recursive:true,force:true}); }
  console.log('PASS public Bubblewrap scope executes with authorized workspace; cleanup waits for use and close');
  let cleaned = 0;
  await runSandboxScope(backend(live, { cleanup: async () => { cleaned++; } }), async ({child, control}) => {
    await ready(child); assert.equal(control.closed, false); return 'protocol done';
  }, 200).then(result => assert.equal(result, 'protocol done'));
  assert.equal(cleaned, 1);
  let retained!: ManagedSandboxProcess;
  await assert.rejects(runSandboxScope(backend(ignored), async managed => {
    retained = managed; await ready(managed.child);
    registerRunningProcess({ taskRunId:'run',participantId:'p',child:managed.control,executionBackend:'local',harnessType:'codex' });
    return 'protocol done';
  }, 30), /unknown/);
  clearRunningProcess('p'); assert.equal(getRunningProcess('p')?.child, retained.control);
  assert.equal(retained.control.closed, false);
  assert.equal(requestRunControl('run','p','stop_run').applied, true);
  assert.equal((await retained.stop({signal:'SIGKILL',deadlineMonotonicMs:performance.now()+1000})).kind, 'exited');
  assert.equal(getRunningProcess('p'), null);
  let cleanupCount = 0;
  const original = new Error('protocol rejected');
  await assert.rejects(runSandboxScope(backend(live, {cleanup: async () => { throw new Error('cleanup rejected'); }}), async ({child}) => {
    await ready(child); throw original;
  }, 200), error => {
    assert.ok(error instanceof SandboxScopeError);
    assert.deepEqual(error.causes.map(c => c instanceof Error ? c.message : String(c)), ['protocol rejected', 'cleanup rejected']);
    assert.match(error.message, /protocol rejected.*cleanup rejected/); return true;
  });
  await assert.rejects(runSandboxScope(backend(live, {cleanup: async () => { throw new Error('cleanup only'); }}), async ({child}) => {
    await ready(child); return 'success';
  }, 200), /cleanup only/);
  await assert.rejects(runSandboxScope(backend(live), async ({child}) => { await ready(child); throw original; }, 200), e => e === original);
  await assert.rejects(runSandboxScope(backend(live, {
    start: () => { throw new Error('sync spawn'); }, cleanup: async () => { cleanupCount++; },
  }), async () => { throw new Error('must not use'); }), /sync spawn/);
  await assert.rejects(runSandboxScope(backend(live, {
    start: () => spawn('/does-not-exist-s01', [], {stdio:'pipe'}), cleanup: async () => { cleanupCount++; },
  }), async () => { throw new Error('must not use'); }), /ENOENT/);
  assert.equal(cleanupCount, 2);
  let reads = 0;
  let changed!: ManagedSandboxProcess;
  await assert.rejects(runSandboxScope(backend(live, {
    captureIdentity: pid => { const identity = captureSandboxIdentity(pid); return ++reads === 1 ? identity : {...identity, root:{...identity.root,startTime:'0'}}; },
  }), async managed => { changed = managed; await ready(managed.child); }, 30), /identity changed/);
  assert.equal(changed.child.killed, false);
  registerRunningProcess({taskRunId:'changed',participantId:'changed',child:changed.control,executionBackend:'local',harnessType:'codex'});
  assert.equal(requestRunControl('changed','changed','stop_run').applied, false, 'Registry must report Manager signal refusal');
  assert.equal(consumeRunControlRequest('changed'), null, 'Refused Manager signal must not mark the run stopped');
  const changedClosed = once(changed.child, 'close'); changed.child.kill('SIGKILL'); await changedClosed;
  let old!: ManagedSandboxProcess;
  let lateCleaned = false;
  await assert.rejects(runSandboxScope(backend(ignored, {cleanup: async () => {lateCleaned = true;}}), async managed => {
    old = managed; await ready(managed.child);
    registerRunningProcess({taskRunId:'old',participantId:'late',child:managed.control,executionBackend:'local',harnessType:'codex'});
  }, 30), /unknown/);
  assert.equal(lateCleaned, false);
  const replacement = {taskRunId:'new',participantId:'late',child:{kill:()=>true},executionBackend:'local',harnessType:'codex'};
  registerRunningProcess(replacement);
  await old.stop({signal:'SIGKILL',deadlineMonotonicMs:performance.now()+1000});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getRunningProcess('late'), replacement); assert.equal(lateCleaned, true);
  clearRunningProcess('late', 'old'); assert.equal(getRunningProcess('late'), replacement);
  clearRunningProcess('late'); assert.equal(getRunningProcess('late'),null);
  let lateFailure!: SandboxScopeError;
  let lateFailureProcess!: ManagedSandboxProcess;
  const lateCleanupError = new Error('late cleanup rejected');
  await assert.rejects(runSandboxScope(backend(ignored, {cleanup: async () => {throw lateCleanupError;}}), async managed => {
    lateFailureProcess = managed; await ready(managed.child); throw original;
  }, 30), error => {
    assert.ok(error instanceof SandboxScopeError); lateFailure = error;
    assert.equal(error.causes[0], original); return true;
  });
  await lateFailureProcess.stop({signal:'SIGKILL', deadlineMonotonicMs:performance.now()+1000});
  const lateReceipt = await lateFailure.cleanupCompletion;
  assert.ok(lateReceipt, 'unknown scope must expose eventual cleanup outcome');
  assert.equal(lateReceipt.kind,'failed');
  assert.equal(lateReceipt.errors[0],original);
  assert.ok(lateReceipt.errors.includes(lateCleanupError));
  const unknownCause = lateReceipt.errors[1];
  assert.ok(unknownCause instanceof Error); assert.match(unknownCause.message,/unknown/);
  console.log('PASS initial unknown scope exposes late cleanup failure and original exception through nonrejecting completion receipt');
  let unidentified!: import('../src/lib/sandbox-manager/lifecycle').ManagedProcessControl;
  let unidentifiedChild!: ReturnType<typeof spawn>;
  await assert.rejects(runSandboxScope(backend(live, {
    start: () => unidentifiedChild = spawn(process.execPath,['-e',live],{stdio:'pipe'}),
    captureIdentity: () => { throw new Error('identity unavailable'); },
  }), async () => { throw new Error('must not use'); }, 30, {onSpawn: control => {unidentified = control;}}), /identity unavailable/);
  assert.equal(unidentified.identity, null); assert.equal(unidentified.kill('SIGKILL'), false);
  const unidentifiedClose = once(unidentifiedChild,'close'); unidentifiedChild.kill('SIGKILL'); await unidentifiedClose;
  await assert.rejects(runSandboxScope(backend(live), async () => { throw new Error('must not use'); }, 200,
    {onSpawn: () => {throw new Error('registration failed');}}), /registration failed/);
  console.log('PASS capture failure retains control before use; onSpawn failure enters cleanup; stale participant clear preserves new run');
  console.log('PASS startup sync/async errors skip use and clean; identity mismatch refuses signal; late close retains newer entry');
  console.log('PASS original error preserved; cleanup failure rejects success; combined causes visible; unknown retains resources until close');
  console.log('PASS protocol completion waits for close; TERM timeout retains control; later SIGKILL closes');
}
main().catch(error => { console.error(error); process.exitCode=1; });
