import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { buildIssueGraph } from '../src/lib/task-graph/issue-route';
import { createTaskGraphRun, releaseReadyNodes, claimNode } from '../src/lib/task-graph/store';
import { enqueueIssueSync, syncIssueDelivery } from '../src/lib/task-graph/issue-sync';
import { inspectIssueDispatch } from '../src/lib/task-graph/issue-dispatch';
import type { TrackerRequest } from '../src/lib/task-graph/issue-tracker';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'issues-execution-'));
  const repository = path.join(root, 'repo');
  mkdirSync(repository);
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'baseline'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  const secondRepository = path.join(root, 'second-repo');
  execFileSync('git', ['clone', '--quiet', repository, secondRepository]);
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  const parentRef = 'gitee:org/app#IPARENT';
  const body = (key: string, parent: string | null = parentRef) => `criteria\n<!-- ap-ticket-v1 ${JSON.stringify({ version: 1, project: 'execution-test', sliceKey: key, parent, blockedBy: key === 'C' ? ['gitee:org/app#IA', 'gitee:org/app#IB'] : [] })} -->`;
  const remote = [{ number: 'IPARENT', title: 'Spec', state: 'open', body: body('SPEC', null) }, ...['A', 'B', 'C'].map((key) => ({ number: 'I' + key, title: key, body: body(key), state: 'open' }))];
  const comments = new Map<string, { id: number; body: string }[]>();
  let posts = 0; let closeFails = true; let losePostResponse = false;
  const request: TrackerRequest = async (_provider, endpoint, method = 'GET', payload) => {
    if (endpoint.includes('/comments')) {
      const ref = endpoint.split('/comments')[0];
      if (method === 'GET') return comments.get(ref) || [];
      posts++; comments.set(ref, [...comments.get(ref) || [], { id: posts, body: String(payload?.body) }]);
      if (losePostResponse) { losePostResponse = false; throw new Error('response lost after remote POST'); }
      return { id: posts, body: payload?.body };
    }
    if (method === 'PATCH') {
      if (closeFails) throw new Error('offline before close');
      const id = endpoint.split('/').at(-1); remote.find((issue) => issue.number === id)!.state = 'closed'; return {};
    }
    if (endpoint.includes('?')) return remote;
    const item = remote.find((issue) => endpoint.endsWith('/' + issue.number));
    if (!item) throw new Error(endpoint); return item;
  };
  const require = createRequire(__filename);
  require('../src/lib/task-graph/issue-tracker').trackerRequest = request;
  const feishu = require('../src/lib/task-graph/feishu');
  const notices: string[] = [];
  feishu.postGraphParentProgress = async (_id: string, _key: string, text: string) => { notices.push(text); };
  // All outbound IM remains fake through process exit, including asynchronous relay drains.
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, tenant_access_token: 'fixture', expire: 3600, data: { message_id: 'fixture-message' } }));
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const codex = getHarnessAdapter('codex')!; const kimi = getHarnessAdapter('kimi-code')!;
  const starts: { key: string; directory: string }[] = []; const reviews: string[] = [];
  const oldValidation = process.env.TASK_GRAPH_VALIDATION_ROOT; process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const releaseProbe = process.env.AP_S01_REVIEW_RELEASE_PROBE === '1';
  const phase: typeof import('../src/lib/task-graph/phase-worker') = require('../src/lib/task-graph/phase-worker');
  const releaseWorker = phase.releaseGraphReviewWorker;
  let releaseReview: () => void = () => {};
  const reviewRelease = new Promise<void>(resolve => { releaseReview = resolve; });
  let heldReview = false;
  phase.releaseGraphReviewWorker = async (nodeId, nonce) => {
    const node = releaseProbe ? await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: nodeId } }) : null;
    if (node?.key === 'B' && node.status === 'attention' && !heldReview) { heldReview = true; await reviewRelease; }
    return releaseWorker(nodeId, nonce);
  };
  let rejectB = true;
  let defectReported = false;
  codex.execute = async ({ task, context }) => {
    const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { childTaskId: task.id }, include: { node: true } });
    const key = job.node.key; const directory = context.workingDirectory!;
    starts.push({ key, directory });
    if (key === 'C') {
      assert.ok(existsSync(path.join(directory, 'A.txt')), 'Same repository delivery is inherited');
      const manifests = JSON.parse(context.taskEnvironment?.TASK_GRAPH_UPSTREAM_INPUTS_JSON || '[]');
      assert.ok(manifests.some((manifest: { inputs: { sourcePath: string }[] }) => manifest.inputs.some(input => existsSync(path.join(input.sourcePath, 'B.txt')))), 'Cross-repository join consumes the fixed input');
    }
    writeFileSync(path.join(directory, key + '.txt'), key + (key === 'B' && starts.filter(item => item.key === 'B').length > 1 ? '-fixed' : ''));
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify({ status: 'delivered', note: 'Implemented ' + key, evidence: [key + '.txt'] }), executionTime: 1 };
  };
  kimi.execute = async ({ task, context }) => {
    assert.equal(context.permissionConfig?.sandboxMode, 'workspace-write');
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: task.id.slice('task-graph-review-'.length) }, include: { executions: true } });
    assert.ok(context.extraReadOnlyPaths?.includes(node.executions[0].worktreePath!), 'Use the original implementation code readonly');
    assert.notEqual(context.workingDirectory, node.executions[0].worktreePath, 'Test runtime must be isolated from frozen code');
    writeFileSync(path.join(context.workingDirectory, 'report.json'), '{}');
    reviews.push(node.key);
    if (node.key === 'B' && !rejectB && !defectReported) {
      defectReported = true;
      return { success: true, output: 'TASK_GRAPH_REVIEW {"approved":false,"note":"new input found an in-scope defect","failureKind":"in_scope_defect","failureKey":"acceptance:smoke"}', executionTime: 1 };
    }
    return { success: true, output: `TASK_GRAPH_REVIEW ${JSON.stringify({ approved: node.key !== 'B' || !rejectB, note: 'explicit fixture evidence', ...(node.key === 'B' && rejectB ? { failureKind: 'blocked_require_human' } : {}) })}`, executionTime: 1 };
  };
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const slices = Object.fromEntries(['A', 'B', 'C'].map((key) => [key, {
    executionMode: 'lean' as const, acceptance: { mode: 'agent' as const, reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: { ...participant, harnessType: 'kimi-code', role: 'tester' } }, checks: ['smoke'] },
    executions: [{ key: 'app', instructions: 'fixture', repository: key === 'B' ? secondRepository : repository, gitRef: 'refs/heads/main', baseCommit: baseline, agentSelector: 'local:codex', launchConfig: { participant, checks: [{ name: 'smoke', argv: ['test', '-f', key + '.txt'] }] } }],
  }]));
  const definition = await buildIssueGraph('test://spec', { parent: parentRef, slices }, request);
  const parent = await prisma.task.create({ data: { name: 'Issue execution fixture' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const { runTaskGraphCycle, recoverTaskGraphNodeVerification, startTaskGraphCoordinator } = await import('../src/lib/task-graph/coordinator');
  async function until(stage: string, predicate: () => Promise<boolean>) {
    for (let i = 0; i < 500; i++) { await runTaskGraphCycle(); if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error(JSON.stringify({ stage, starts, reviews, nodes: await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } }), events: await prisma.taskGraphEvent.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'desc' }, take: 40 }), taskRuns: await prisma.taskRun.findMany({ where: { task: { id: { in: (await prisma.taskGraphNode.findMany({ where: { runId: run.id }, select: { id: true } })).map(node => `task-graph-review-${node.id}`) } } }, select: { id: true, taskId: true, status: true, summary: true, controlMetadata: true } }) }, null, 2));
  }
  try {
    await until('initial-review', async () => (await prisma.taskGraphNode.findMany({ where: { runId: run.id }, select: { key: true, status: true } })).filter((node) => node.key !== 'C').every((node) => ['passed', 'attention'].includes(node.status)));
    assert.equal(starts.length, 2); assert.notEqual(starts[0].directory, starts[1].directory);
    const paused = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'B' } }, include: { executions: true } });
    assert.equal(paused.status, 'attention'); assert.ok(existsSync(paused.executions[0].worktreePath!));
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'C' } } })).status, 'planned');
    rejectB = false;
    if (releaseProbe) {
      for (let n = 0; n < 100 && !heldReview; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(heldReview, true, 'Probe holds the old verification before its in-flight entry is cleared');
      const recovery = recoverTaskGraphNodeVerification(run.id, 'B');
      try {
        for (let n = 0; n < 100; n++) {
          if ((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: paused.id } })).status === 'verifying') break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      } finally { releaseReview(); }
      await recovery;
      assert.ok(reviews.filter(key => key === 'B').length >= 2, 'An accepted recovery must launch the new review after the previous in-flight review drains');
    } else await recoverTaskGraphNodeVerification(run.id, 'B');
    await until('recovery-and-join', async () => (await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed');
    assert.deepEqual(starts.map((item) => item.key).sort(), ['A', 'B', 'B', 'C'], 'Only the failed Slice may receive one classified repair; completed independent branches never rerun');
    assert.equal(reviews.filter((key) => key === 'B').length, 3);
    assert.equal(git('rev-parse', 'main'), baseline, 'Run integration must not move source main');
    await enqueueIssueSync(); await enqueueIssueSync();
    const events = await prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: 'issue_sync_requested' }, orderBy: { createdAt: 'asc' } });
    assert.equal(events.length, 3);
    await assert.rejects(() => syncIssueDelivery(events[0].id, request), /offline before close/);
    assert.equal(posts, 1);
    closeFails = false;
    await syncIssueDelivery(events[0].id, request); await syncIssueDelivery(events[0].id, request);
    assert.equal(posts, 1, 'Close retry must reuse the existing comment');
    losePostResponse = true;
    await assert.rejects(() => syncIssueDelivery(events[1].id, request), /response lost/);
    await syncIssueDelivery(events[1].id, request);
    assert.equal(posts, 2, 'Crash reconciliation must read remote marker before sending');
    await Promise.all([syncIssueDelivery(events[2].id, request), syncIssueDelivery(events[2].id, request)]);
    assert.equal(posts, 3, 'Concurrent sync workers may send at most one comment');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'issue_sync_completed' } }), 3);
    remote[1].body += '\nchanged scope';
    const blocked = await inspectIssueDispatch(run.id, definition, request);
    assert.deepEqual(Array.from(blocked).sort(), ['A', 'C']);
    assert.ok(!blocked.has('B'), 'Independent branch must survive another branch drift');
    const drift = await createTaskGraphRun({ parentTaskId: parent.id, version: 2, requestKey: parent.id + ':drift', definition });
    await releaseReadyNodes(drift.id);
    await inspectIssueDispatch(drift.id, definition, request);
    assert.equal(await claimNode(drift.id, 'A', 'must-not-start'), null);
    assert.ok(await claimNode(drift.id, 'B', 'independent'));
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: drift.id, key: 'C' } } })).status, 'attention');
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: drift.id } })).status, 'attention');
    assert.ok(notices.length > 0);
    console.log('Real Git/Bubblewrap pipeline forks, joins, resumes review without reimplementation and reconciles tracker writes after crashes');
  } finally {
    releaseReview();
    const drain = new AbortController(); drain.abort(); await startTaskGraphCoordinator(drain.signal);
    phase.releaseGraphReviewWorker = releaseWorker;
    const children = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id } }, select: { childTaskId: true } });
    const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, select: { id: true } });
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, ...children.flatMap((job) => job.childTaskId ? [job.childTaskId] : []), ...nodes.map((node) => `task-graph-review-${node.id}`)] } } });
    if (oldValidation === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = oldValidation;
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
