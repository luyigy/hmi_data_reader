import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, chmod, stat, symlink, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readKimiSessionBytes, readPiSessionBytes, readAntigravitySessionBytes } from '../src/lib/real-agents/session-size-readers';
import { withNativeSessionSize } from '../src/lib/real-agents/native-session-size';
import { withSessionSizeAdapter } from '../src/lib/harness/session-size';
import { executeRemoteRunnerTask } from '../src/lib/remote-harness/runner-executor';
import type { SessionSizeSample } from '../src/lib/session-size';
import { kimiCodeHarnessAdapter } from '../src/lib/harness/adapters/kimi-code';
import { piAgentHarnessAdapter } from '../src/lib/harness/adapters/pi-agent';
import { antigravityHarnessAdapter } from '../src/lib/harness/adapters/antigravity';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'multi-session-size-'));
  const id = '11111111-1111-1111-1111-111111111111';
  const samples: SessionSizeSample[] = [];
  try {
    const kimi = path.join(root, 'kimi'), session = path.join(kimi, 'sessions/workspace/session_' + id);
    await mkdir(path.join(session, 'agents/main'), { recursive: true });
    const wire = path.join(session, 'agents/main/wire.jsonl'); await writeFile(wire, 'wire\n');
    await writeFile(path.join(session, 'context.jsonl'), 'context\n');
    assert.equal((await readKimiSessionBytes(id, kimi))?.bytes, 13);
    const duplicate = path.join(kimi, 'sessions/other/session_' + id); await mkdir(duplicate, { recursive: true });
    assert.equal(await readKimiSessionBytes(id, kimi), null); await rm(duplicate, { recursive: true });
    assert.equal(await readKimiSessionBytes('../escape', kimi), null);
    const scope = { executionId: 'e', sessionId: id, read: (s: string) => readKimiSessionBytes(s, kimi), onSample: (s: SessionSizeSample) => { samples.push(s); } };
    await withNativeSessionSize(scope, async bind => { await bind(id); await appendFile(wire, 'more'); });
    assert.equal(samples.at(-1)?.deltaBytes, 4);
    await withNativeSessionSize(scope, async bind => { await bind(id); await writeFile(wire, 'x'); });
    assert.equal(samples.at(-1)?.deltaBytes, undefined);
    await symlink(path.join(root, 'secret'), path.join(session, 'bad-link'));
    assert.equal(await readKimiSessionBytes(id, kimi), null);
    await rm(path.join(session, 'bad-link'));

    const base = path.join(root, 'pi'), dir = path.join(base, 'member'); await mkdir(dir, { recursive: true });
    const history = path.join(dir, 'native.jsonl'), header = JSON.stringify({ type: 'session', id }) + '\n';
    await writeFile(history, header); await writeFile(path.join(dir, 'unrelated.log'), 'not history');
    assert.equal((await readPiSessionBytes(dir, base))?.bytes, Buffer.byteLength(header));
    await truncate(history, 256 * 1024 ** 2);
    assert.equal((await readPiSessionBytes(dir, base))?.bytes, 256 * 1024 ** 2);
    assert.equal(await readPiSessionBytes(root, base), null);
    await symlink(history, path.join(dir, 'alias.jsonl')); assert.equal(await readPiSessionBytes(dir, base), null);
    await rm(path.join(dir, 'alias.jsonl')); await writeFile(history, header);

    const agy = path.join(root, 'agy'), db = path.join(agy, 'conversations', id + '.db');
    await mkdir(path.dirname(db), { recursive: true }); await writeFile(db, 'SQLite format 3\0');
    await writeFile(db + '-wal', 'wal'); await writeFile(db + '-shm', 'excluded');
    assert.equal((await readAntigravitySessionBytes(id, agy))?.bytes, 19);
    assert.equal(await readAntigravitySessionBytes('../bad', agy), null);
    await withNativeSessionSize({ ...scope, read: s => readAntigravitySessionBytes(s, agy) }, async bind => {
      await bind(id); await rm(db + '-wal'); await appendFile(db, 'checkpoint');
    });
    assert.equal(samples.at(-1)?.deltaBytes, undefined, 'WAL checkpoint is not fabricated growth');

    // Real exported adapters, real fixture files, native transport only stubbed.
    const task = { id: 'size-fixture', name: 'fixture' };
    const context = { executionBackend: 'platform_local' as const, executionId: 'adapter', workingDirectory: root,
      timeout: 1000, runtimeHome: root, sessionKey: 'size-fixture', onSessionStarted: async () => {},
      onSessionSize: (sample: SessionSizeSample) => { samples.push(sample); } };
    const kimiAgent = require('../src/lib/real-agents/kimi-code-agent');
    const originalKimi = kimiAgent.executeKimiCodeTask;
    kimiAgent.executeKimiCodeTask = async (_: unknown, config: any) => {
      const active = path.join(root, '.kimi-code/sessions/workspace/session_' + id + '/agents/main');
      await mkdir(active, { recursive: true }); await writeFile(path.join(active, 'wire.jsonl'), 'native');
      await config.onSessionStarted(id); await appendFile(path.join(active, 'wire.jsonl'), ' failure');
      return { success: false, error: 'fixture', executionTime: 1 };
    };
    try { await kimiCodeHarnessAdapter.execute({ task, context }); assert.equal(samples.at(-1)?.totalBytes, 14); }
    finally { kimiAgent.executeKimiCodeTask = originalKimi; }
    // Reader injection keeps Pi/Antigravity fixtures isolated from actual user home.
    for (const [adapter, sessionId, read, kind] of [
      [piAgentHarnessAdapter, dir, () => readPiSessionBytes(dir, base), 'pi_session_dir'],
      [antigravityHarnessAdapter, id, () => readAntigravitySessionBytes(id, agy), 'antigravity_conversation'],
    ] as const) {
      const measured = withSessionSizeAdapter({ ...adapter, execute: async args => {
        await args.context.onSessionStarted?.({ sessionId, sessionKind: kind });
        return { success: false, error: 'fixture', executionTime: 1, sessionId, sessionKind: kind };
      } }, { read });
      await measured.execute({ task, context });
      assert.equal(samples.at(-1)?.totalBytes, (await read())?.bytes);
      const count = samples.length;
      await measured.execute({ task, context: { ...context, executionBackend: 'remote_ssh' } });
      assert.equal(samples.length, count, 'remote paths must never be sampled on the local host');
    }
    const binary = path.join(root, 'kimi-fixture');
    await writeFile(binary, `#!${process.execPath}
const fs=require('fs'), path=require('path');
const dir=path.join(process.env.KIMI_CODE_HOME,'sessions/workspace/session_${id}/agents/main');
fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'wire.jsonl'),'start');
console.log(JSON.stringify({role:'meta',type:'session.resume_hint',session_id:'${id}'}));
setTimeout(()=>{fs.appendFileSync(path.join(dir,'wire.jsonl'),' failed');process.exit(1)},100);
`);
    await chmod(binary, 0o755);
    const oldBinary = process.env.KIMI_CODE_CLI_PATH; process.env.KIMI_CODE_CLI_PATH = binary;
    let nativeBound = false;
    try {
      const result = await kimiCodeHarnessAdapter.execute({ task, context: { ...context,
        permissionConfig: { profile: 'full_access', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccess: 'enabled', writableRoots: [root] },
        onSessionStarted: async session => { assert.equal(session.sessionId, id); nativeBound = true; } } });
      assert.equal(result.success, false); assert.equal(nativeBound, true);
      assert.equal(samples.at(-1)?.totalBytes, 12, 'native failure still flushes the bound history size');
    } finally { if (oldBinary === undefined) delete process.env.KIMI_CODE_CLI_PATH; else process.env.KIMI_CODE_CLI_PATH = oldBinary; }

    const nativePi = require('../src/lib/real-agents/pi-agent');
    const piOriginal = { execute: nativePi.executePiAgentTask, resume: nativePi.resumePiAgentSession, resolve: nativePi.resolvePiAgentSessionDir };
    const oldPiRoot = process.env.PI_AGENT_SESSION_ROOT;
    process.env.PI_AGENT_SESSION_ROOT = base;
    nativePi.resolvePiAgentSessionDir = () => dir;
    nativePi.executePiAgentTask = async () => { await appendFile(history, 'native pi\n'); return { success: true, sessionDir: dir, executionTime: 1 }; };
    nativePi.resumePiAgentSession = async () => { await appendFile(history, 'resume pi\n'); return { success: false, sessionDir: dir, executionTime: 1 }; };
    try {
      await piAgentHarnessAdapter.execute({ task, context });
      assert.equal(samples.at(-1)?.deltaBytes, Buffer.byteLength('native pi\n'));
      await piAgentHarnessAdapter.resume!({ task, context, sessionId: dir, continuationMessage: 'go' });
      assert.equal(samples.at(-1)?.deltaBytes, Buffer.byteLength('resume pi\n'));
    } finally {
      Object.assign(nativePi, { executePiAgentTask: piOriginal.execute, resumePiAgentSession: piOriginal.resume, resolvePiAgentSessionDir: piOriginal.resolve });
      if (oldPiRoot === undefined) delete process.env.PI_AGENT_SESSION_ROOT; else process.env.PI_AGENT_SESSION_ROOT = oldPiRoot;
    }
    const os = require('node:os'), oldHome = os.homedir;
    const nativeAgy = require('../src/lib/real-agents/antigravity-agent'), agyExecute = nativeAgy.executeAntigravityTask;
    const nativeDb = path.join(root, '.gemini/antigravity-cli/conversations', id + '.db');
    await mkdir(path.dirname(nativeDb), { recursive: true });
    os.homedir = () => root;
    nativeAgy.executeAntigravityTask = async (_: unknown, config: any) => {
      await writeFile(nativeDb, 'SQLite format 3\0'); await config.onSessionStarted(id);
      await appendFile(nativeDb, 'native agy'); return { success: false, sessionId: id, executionTime: 1 };
    };
    try { await antigravityHarnessAdapter.execute({ task, context }); assert.equal(samples.at(-1)?.totalBytes, 26); }
    finally { os.homedir = oldHome; nativeAgy.executeAntigravityTask = agyExecute; }

    let resolveRead!: (value: { bytes: number; identity: string }) => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const switched: SessionSizeSample[] = [];
    await withNativeSessionSize({ executionId: 'switch', read: async session => {
      if (session === 'old') { readStarted(); return new Promise(resolve => { resolveRead = resolve; }); }
      return { bytes: 2, identity: 'new-file' };
    }, onSample: sample => { switched.push(sample); } }, async bind => {
      const first = bind('old'); await started;
      const second = bind('new'); resolveRead({ bytes: 999, identity: 'old-file' });
      await Promise.all([first, second]);
    });
    assert.ok(switched.length > 0);
    assert.ok(switched.every(sample => sample.sessionId === 'new' && sample.totalBytes === 2), 'in-flight old sampling cannot be attributed to a new native session');

    const originalFetch = globalThis.fetch;
    const remoteSession = 'C:\\Users\\pi\\sessions\\member';
    let remoteSamples = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({ type: 'complete', success: true, output: 'remote done',
      sessionDir: remoteSession, sessionSize: { totalBytes: 200, deltaBytes: 30 } }) + '\n');
    try {
      const result = await executeRemoteRunnerTask({ nodeName: 'fixture', taskId: 't', cwd: 'C:\\work', prompt: 'go', timeout: 1000,
        onSessionSize: async (session, size) => { assert.equal(session, remoteSession); assert.deepEqual(size, { totalBytes: 200, deltaBytes: 30 }); remoteSamples++; } });
      assert.equal(result.sessionId, remoteSession); assert.equal(remoteSamples, 1);
      const stillCompletes = await executeRemoteRunnerTask({ nodeName: 'fixture', taskId: 't', cwd: 'C:\\work', prompt: 'go', timeout: 1000,
        onSessionSize: async () => { throw new Error('telemetry unavailable'); } });
      assert.equal(stillCompletes.output, 'remote done');
    } finally { globalThis.fetch = originalFetch; }
    console.log('PASS Kimi/Pi/Antigravity bytes, large files, containment, duplicate identity, growth, replacement/WAL, native adapter failure and remote isolation');
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
