import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { withAttemptServices } from '../src/lib/task-graph/attempt-services';
import { materializeUpstream } from '../src/lib/task-graph/upstream-source';
import { validateServices, type GraphService } from '../src/lib/task-graph/service-contract';
import type { TaskInputManifest } from '../src/lib/task-graph/upstream-inputs';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'service-test-'));
  const repository = path.join(root, 'source'); await mkdir(repository);
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8' }).trim();
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'cache');
  const service: GraphService = { key: 'upstream', input: 'A/api', runtime: 'node', entry: 'server.js',
    args: ['127.0.0.1', '{port}', '{data}'], healthPath: '/health', startupTimeoutMs: 1000 };
  const source = `const http=require('http'),fs=require('fs');if(require('service-dependency')!=='reused')process.exit(11);
const [host,port,data]=process.argv.slice(2); fs.writeFileSync(data+'/state','isolated');
try {fs.writeFileSync(__dirname+'/host-mutation','bad');process.exit(9)} catch {}
if(process.env.DATABASE_URL || process.env.OPENAI_API_KEY)process.exit(8);
http.createServer((req,res)=>res.end(JSON.stringify({entry:__filename,data}))).listen(Number(port),host);`;
  const dependencies = path.join(repository, 'node_modules'); await mkdir(path.join(dependencies, 'service-dependency'), { recursive: true });
  await writeFile(path.join(dependencies, 'service-dependency/index.js'), `module.exports='reused'`);
  await writeFile(path.join(repository, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(repository, 'server.js'), source);
  await writeFile(path.join(repository, 'broken.js'), 'throw new Error("startup failure")');
  await writeFile(path.join(repository, 'collision.js'), `require('http').createServer((q,s)=>s.end('wrong')).listen(Number(process.argv[5]),'127.0.0.1')`);
  await writeFile(path.join(repository, 'idle.js'), 'setInterval(()=>{},1000)');
  await writeFile(path.join(repository, 'server.py'), `import http.server,sys,pathlib\nhost,port,data=sys.argv[1:]\npathlib.Path(data,'state').write_text('python')\nhttp.server.HTTPServer((host,int(port)), http.server.SimpleHTTPRequestHandler).serve_forever()\n`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  git('add', '.'); git('commit', '-m', 'fixed service'); const commit = git('rev-parse', 'HEAD');
  const sourcePath = await materializeUpstream(repository, commit);
  const input = { repository, commit, sourcePath, executions: ['A/api'], resultsDirectories: [], projectEnvPath: null, pythonExecutable: null, dependencyPaths: [dependencies], quality: ['passed'] };
  const manifest: TaskInputManifest = { version: 1, executionId: 'job', primaryRepository: root, hash: 'fixture', inputs: [input] };
  const directory = path.join(root, 'runtime');
  const receipts: { directory: string }[] = [];
  const record = async (_kind: string, payload: object) => { if ('directory' in payload && typeof payload.directory === 'string') receipts.push({ directory: payload.directory }); };
  let url = '';
  const args = { services: [service], manifests: [manifest], directory, record };
  try {
    assert.throws(() => validateServices([{ ...service, args: [] }]));
    assert.throws(() => validateServices([{ ...service, entry: '../escape.js' }]));
    await withAttemptServices(args, async context => {
      const receipt = context.receipts[0]; url = `http://127.0.0.1:${receipt.port}`;
      assert.ok(receipt.runtime !== 'postgres');
      assert.equal(receipt.health, 'healthy'); assert.equal(receipt.commit, commit);
      const response = await fetch(url); const body = await response.json();
      assert.equal(body.entry, path.join(sourcePath, 'server.js'));
      assert.equal(await readFile(path.join(body.data, 'state'), 'utf8'), 'isolated');
      assert.equal(JSON.parse(context.env.TASK_GRAPH_SERVICES_JSON)[0].url, url);
    });
    await assert.rejects(fetch(url), /fetch failed/);
    const saved = JSON.parse(await readFile(path.join(receipts.at(-1)!.directory, 'receipt.json'), 'utf8'));
    assert.equal(saved.receipts[0].closed, true);
    await assert.rejects(readFile(path.join(receipts.at(-1)!.directory, 'upstream/state')), /ENOENT/);
    await assert.rejects(withAttemptServices(args, async () => { throw new Error('check failed'); }), /check failed/);
    await assert.rejects(withAttemptServices({ ...args, services: [{ ...service, entry: 'broken.js' }] }, async () => {}), /startup failure|提前退出/);
    await assert.rejects(withAttemptServices({ ...args, services: [{ ...service, entry: 'idle.js', startupTimeoutMs: 100 }] }, async () => {}), /健康检查超时/);
    await assert.rejects(withAttemptServices({ ...args, timeoutMs: 100 }, async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    }), /超时/);
    const cancel = new AbortController();
    await assert.rejects(withAttemptServices({ ...args, signal: cancel.signal }, async ({ signal }) => {
      cancel.abort(); assert.equal(signal.aborted, true);
    }), /取消/);
    await assert.rejects(withAttemptServices({ ...args, services: [{ ...service, input: 'not/consumed' }] }, async () => {}), /未消费/);
    const oldService = createServer((_request, response) => response.end('old service'));
    await new Promise<void>(resolve => oldService.listen(0, '127.0.0.1', resolve));
    try {
      const address = oldService.address(); assert.ok(address && typeof address !== 'string');
      await assert.rejects(withAttemptServices({ ...args, services: [{ ...service, entry: 'collision.js', args: [...service.args, String(address.port)] }] }, async () => { assert.fail('An old 200 response cannot certify a failed service'); }), /EADDRINUSE|提前退出/);
      assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'old service', 'Conflict cleanup must not kill an unrelated server');
    } finally { await new Promise<void>(resolve => oldService.close(() => resolve())); }
    await Promise.all([1, 2].map(() => withAttemptServices(args, async context => {
      const body = await (await fetch(`http://127.0.0.1:${context.receipts[0].port}`)).json();
      assert.equal(await readFile(path.join(body.data, 'state'), 'utf8'), 'isolated');
    })));
    const crashReceipt = path.join(root, 'crash.json');
    const helper = path.join(root, 'owner.cjs');
    await writeFile(helper, `const {withAttemptServices}=require(${JSON.stringify(path.resolve('src/lib/task-graph/attempt-services.ts'))});require('fs');withAttemptServices(${JSON.stringify({ services: [service], manifests: [manifest], directory })},async ctx=>{require('fs').writeFileSync(${JSON.stringify(crashReceipt)},JSON.stringify(ctx.receipts));await new Promise(()=>{});}).catch(e=>{console.error(e);process.exit(1)});`);
    const owner = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', helper], { env: process.env, stdio: 'ignore' });
    try {
      let ready = false;
      for (let n = 0; n < 200; n++) { if (await readFile(crashReceipt).then(() => true, () => false)) { ready = true; break; } await delay(25); }
      assert.equal(ready, true, 'Crash test owner must start a real server');
      const [receipt] = JSON.parse(await readFile(crashReceipt, 'utf8'));
      const exited = new Promise<void>(resolve => owner.once('close', () => resolve())); owner.kill('SIGKILL'); await exited;
      let alive = true;
      for (let n = 0; n < 100; n++) { alive = await fetch(`http://127.0.0.1:${receipt.port}`).then(() => true, () => false); if (!alive) break; await delay(25); }
      assert.equal(alive, false, 'Owner crash must kill the service namespace');
    } finally { owner.kill('SIGKILL'); }
    const venv = path.join(repository, '.venv');
    execFileSync('python3', ['-m', 'venv', '--without-pip', venv]);
    await withAttemptServices({ ...args, manifests: [{ ...manifest, inputs: [{ ...input, projectEnvPath: venv, pythonExecutable: path.join(venv, 'bin/python') }] }],
      services: [{ ...service, runtime: 'python', entry: 'server.py', healthPath: '/' }] }, async ({ receipts }) => {
      const response = await fetch(`http://127.0.0.1:${receipts[0].port}/state`); assert.equal(await response.text(), 'python');
    });
    await delay(50);
    console.log('Services verify fixed entry, owned loopback, isolated data, real Python environment and cleanup on success/failure/timeout/cancel');
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
