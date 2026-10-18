import { executionProgress } from '../src/lib/task-graph/execution-progress';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-services-'));
  const repository = path.join(root, 'api'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'server.js'), `const http=require('http'),fs=require('fs');const[host,port,data]=process.argv.slice(2);fs.writeFileSync(data+'/state','test');http.createServer((q,s)=>s.end(q.url==='/nonce'?(process.env.AP_GRAPH_WRITER_NONCE||''):'fixed-api')).listen(Number(port),host);`);
  git('add', '.'); git('commit', '-m', 'api'); const commit = git('rev-parse', 'HEAD');
  const app = path.join(root, 'app'); execFileSync('git', ['clone', '--quiet', repository, app]);
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream'); process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'harness'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename); const feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).startsWith('http://127.0.0.1:') ? realFetch(url, options) : new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const reviewer = { ...participant, harnessType: 'kimi-code', role: 'tester' };
  const urls: string[] = []; const phases = new Set<string>();
  getHarnessAdapter('codex')!.execute = async ({ context }) => {
    const inputs = context.taskEnvironment?.TASK_GRAPH_SERVICES_JSON;
    if (inputs) { const [service] = JSON.parse(inputs); urls.push(service.url); assert.equal(await (await fetch(service.url)).text(), 'fixed-api'); assert.ok(context.taskEnvironment?.AP_GRAPH_WRITER_NONCE); assert.equal(await (await fetch(service.url + '/nonce')).text(), context.taskEnvironment.AP_GRAPH_WRITER_NONCE, 'Implementation service inherits the durable TaskRun nonce'); phases.add('implementation'); }
    writeFileSync(path.join(context.workingDirectory!, 'done'), 'delivered');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["done"]}', executionTime: 1 };
  };
  getHarnessAdapter('kimi-code')!.execute = async ({ task, context }) => {
    const [service] = JSON.parse(context.taskEnvironment!.TASK_GRAPH_SERVICES_JSON);
    urls.push(service.url); assert.equal(await (await fetch(service.url)).text(), 'fixed-api'); assert.ok(context.taskEnvironment?.AP_GRAPH_WRITER_NONCE); assert.equal(await (await fetch(service.url + '/nonce')).text(), context.taskEnvironment.AP_GRAPH_WRITER_NONCE, 'Review service inherits the durable TaskRun nonce');
    const architecture = task.id.startsWith('task-graph-architecture-'); phases.add(architecture ? 'architecture' : 'acceptance');
    return { success: true, output: architecture ? 'TASK_GRAPH_ARCH_REVIEW {"approved":true,"note":"contract checked"}' : 'TASK_GRAPH_REVIEW {"approved":true,"note":"live service checked"}', executionTime: 1 };
  };
  const parent = await prisma.task.create({ data: { name: 'services' } });
  const definition = { specRef: 'fixture://services', nodes: [
    { key: 'API', goal: 'API', dependsOn: [], executionMode: 'implement' as const, acceptance: { mode: 'automatic' as const, checks: [] }, executions: [{ key: 'api', repository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'api', launchConfig: { participant, checks: [] } }] },
    { key: 'APP', goal: 'APP', dependsOn: ['API'], executionMode: 'full' as const,
      services: [{ key: 'api', input: 'API/api', runtime: 'node' as const, entry: 'server.js', args: ['127.0.0.1', '{port}', '{data}'], healthPath: '/' }],
      architectureReview: { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: reviewer } },
      acceptance: { mode: 'agent' as const, reviewerId: 'local:kimi-code', checks: ['live'], reviewLaunchConfig: { participant: reviewer },
        integrationChecks: [{ name: 'live', repository: app, argv: ['node', '-e', 'const s=JSON.parse(process.env.TASK_GRAPH_SERVICES_JSON)[0];fetch(s.url).then(r=>r.text()).then(t=>{if(t!=="fixed-api")process.exit(2)})'] }] },
      executions: [{ key: 'app', repository: app, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'app', launchConfig: { participant, checks: [{ name: 'live', argv: ['node', '-e', 'if(!process.env.TASK_GRAPH_SERVICES_JSON)process.exit(2)'] }] } }] },
  ] };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  let badRunId: string | null = null;
  try {
    for (let n = 0; n < 400; n++) {
      await runTaskGraphCycle(); const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'APP' } } });
      if (node.status === 'passed') break;
      if (await prisma.taskGraphNode.count({ where: { runId: run.id, status: 'attention' } })) throw new Error(JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { runId: run.id }, take: 8, orderBy: { createdAt: 'desc' } })));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'APP' } } })).status, 'passed');
    assert.deepEqual(Array.from(phases).sort(), ['acceptance', 'architecture', 'implementation']);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'service_attempt_ready' } }), 5);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'service_attempt_closed' } }), 5);
    for (const url of urls) await assert.rejects(realFetch(url), /fetch failed/);
    const broken = structuredClone(definition); broken.nodes[1].services![0].entry = 'missing.js';
    const badParent = await prisma.task.create({ data: { name: 'bad service input' } });
    const bad = await createTaskGraphRun({ parentTaskId: badParent.id, version: 1, requestKey: badParent.id, definition: broken }); badRunId = bad.id;
    const previousModelStarts = urls.length;
    for (let n = 0; n < 300; n++) {
      await runTaskGraphCycle();
      if (await prisma.taskGraphNode.count({ where: { runId: bad.id, key: 'APP', status: 'attention' } })) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const failed = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: bad.id, key: 'APP' } }, include: { executions: true } });
    assert.equal(failed.status, 'attention'); assert.equal(failed.executions[0].issueKind, 'retry_exhausted');
    const progress = executionProgress(failed.executions[0].dispatchMetadata); assert.ok(progress);
    assert.equal(progress.state, 'exhausted'); assert.equal(progress.platformAttempts, 2); assert.equal(progress.lastFailure?.code, 'environment_failed');
    assert.equal(urls.length, previousModelStarts, 'Bad service entry must not start another implementation model');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: failed.id, kind: 'service_attempt_failed' } }), 3, 'Two bounded retries retain each service failure receipt, then explicitly exhaust');
    console.log('Implementation, platform check, integration check, architecture and acceptance use attempt-owned services and release all ports');
  } finally { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); globalThis.fetch = realFetch; if (badRunId) await prisma.taskGraphRun.delete({ where: { id: badRunId } }); await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
