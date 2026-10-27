import { resourceWorkspaceRegression } from './task-resource-workspace.fixture';
import { finalOutputRegression } from './task-resource-final-output.fixture';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import type { AcpxRunRequest } from '../src/lib/acpx/types';
import { decideResourceAccess, getResourceApproval, resolveResourceAccess } from '../src/lib/task-resources/access';
import { reconcileResourceApprovals, drainResourceApprovals } from '../src/lib/task-resources/reconcile';
import { observeResourceRunExit, resourceRunExitMatches } from '../src/lib/task-resources/run-exit';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';

async function main() {
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => ({ projects: [] });
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  process.env.FEISHU_ADMIN_OPEN_ID = 'runtime-resource-admin';
  const root = await mkdtemp(join(tmpdir(), 'resource-runtime-'));
  const cwd = join(root, 'workspace'), source = join(root, 'library'), output = join(root, 'output'), hidden = join(root, 'hidden');
  await Promise.all([cwd, source, output, hidden].map(directory => mkdir(directory)));
  const preserved = join(output, '.venv');
  await mkdir(preserved);
  await writeFile(join(preserved, 'keep'), 'readonly dependency');
  await symlink(hidden, join(source, 'escape'));
  await writeFile(join(source, 'input.txt'), 'approved input'); await writeFile(join(hidden, 'secret'), 'unapproved input');
  const cards = require('../src/lib/task-resources/cards');
  const originalPublish = cards.publishResourceApproval;
  const published: string[] = [];
  cards.publishResourceApproval = async (id: string) => { published.push(id); };
  const adapter = getHarnessAdapter('codex')!;
  const original = { execute: adapter.execute, resume: adapter.resume };
  const native = 'resource-runtime-original-native';
  let turns = 0;
  const requests: Array<{ cwd: string; native: string | null; role: string }> = [];
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    turns += 1;
    assert(turns <= 2, 'Approval replay must not dispatch an extra writer');
    const continuation = 'sessionId' in args ? args.sessionId : null;
    requests.push({ cwd: args.context.workingDirectory, native: continuation, role: args.context.sessionKey || '' });
    assert.equal(args.context.workingDirectory, cwd);
    if (turns === 1) {
      assert.equal(continuation, null);
      assert(!args.context.extraReadOnlyPaths?.includes(source));
      assert(!args.context.extraWritableRoots?.includes(output));
    } else {
      assert.equal(continuation, native);
      assert(args.context.extraReadOnlyPaths?.includes(source));
      assert(args.context.extraWritableRoots?.includes(output));
    }
    const probe = turns === 1
      ? `const fs=require('fs'),a=require('assert/strict');a.equal(fs.existsSync(${JSON.stringify(source)}),false);a.equal(fs.existsSync(${JSON.stringify(join(output, 'result.txt'))}),false);a.throws(()=>fs.writeFileSync(${JSON.stringify(join(preserved, 'keep'))},'bad'));`
      : `const fs=require('fs'),a=require('assert/strict');a.equal(fs.readFileSync(${JSON.stringify(join(source, 'input.txt'))},'utf8'),'approved input');a.throws(()=>fs.writeFileSync(${JSON.stringify(join(source, 'forbidden'))},'bad'));fs.writeFileSync(${JSON.stringify(join(output, 'result.txt'))},'mounted and continued');a.equal(fs.existsSync(${JSON.stringify(hidden)}),false);a.throws(()=>fs.writeFileSync(${JSON.stringify(join(preserved, 'keep'))},'bad'));`;
    const plan = prepareSandboxEnvironment({ command: process.execPath, commandArgs: ['-e', probe + 'setTimeout(()=>process.exit(0),300)'], cwd,
      workspaceRoot: cwd, writableRoots: args.context.extraWritableRoots, readOnlyPaths: args.context.extraReadOnlyPaths,
      sandboxMode: 'workspace-write', networkAccess: 'restricted', env: { ...process.env, ...args.context.taskEnvironment } });
    const command = renderBubblewrap(plan);
    const child = spawn(command.command, command.args, { cwd, env: plan.env, stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    args.context.onSpawn?.(child);
    const exited = once(child, 'exit');
    await args.context.onSessionStarted?.({ sessionId: native, sessionKind: 'codex_thread', threadId: native });
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    const final = turns === 1 ? `<resource-request>${JSON.stringify({ purpose: 'Read library and write task result', resources: [{ path: source, access: 'read' }, { path: output, access: 'write' }] })}</resource-request>` : 'continued with approved resources';
    const stream = args.context.streamCallbacks?.onStdoutChunk;
    await stream?.('已检查目录，准备申请。', { id: 'progress', phase: 'commentary' });
    await stream?.(final.slice(0, 20), { id: 'final', phase: 'final_answer' });
    await stream?.(final.slice(20), { id: 'final', phase: 'final_answer' });
    await stream?.(final, { id: 'final', phase: 'final_answer', operation: 'replace' });
    return { success: true, output: '已检查目录，准备申请。\n\n' + final,
      sessionId: native, sessionKind: 'codex_thread', threadId: native, executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute;
  try {
    const task = await prisma.task.create({ data: { name: 'resource runtime', workingDirectory: cwd } });
    const room = await prisma.liveRoom.create({ data: { title: 'resource task', sourceTaskId: task.id, workingDirectory: cwd } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: task.id, chatId: 'fixture-chat', chatType: 'p2p', senderOpenId: 'fixture-user', liveRoomId: room.id } });
    const launch: AcpxRunRequest = { taskId: task.id, taskName: task.name, orchestrationMode: 'single', workingDirectory: cwd, extraReadOnlyPaths: [preserved],
      participants: [{ gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', agentId: 'resource-agent' }],
      permissionConfig: { profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [cwd] } };
    const first = await executeAcpxTaskRun(launch);
    assert.equal(first.status, 'completed', JSON.stringify(first));
    const rows = (await prisma.feishuAdminApproval.findMany({ where: { kind: 'task_resources' } })).filter(row => JSON.parse(row.payloadJson || '{}').launch?.taskId === task.id);
    assert.equal(rows.length, 1, 'Final resource protocol persists exactly one approval');
    const id = rows[0].id;
    assert.equal(published.filter(value => value === id).length, 1, 'Commentary plus final publishes one initial card intent');
    let approval = await getResourceApproval(id);
    assert.equal(approval.status, 'pending'); assert.equal(approval.payload.resources.length, 2);
    assert.deepEqual(await resolveResourceAccess(launch), { approvalIds: [], resources: [] });
    const sourceRunId = approval.payload.source!.taskRunId;
    const finished = await observeResourceRunExit(sourceRunId);
    assert.equal(finished.observation.kind, 'exited', 'Ordinary continuation uses the completed runner lifecycle');
    assert.equal(JSON.parse(finished.identity!.controlMetadata!).graphWriter, undefined);
    await prisma.$transaction(async tx => {
      await tx.taskRun.update({ where: { id: sourceRunId }, data: { status: 'running' } });
      assert.equal(await resourceRunExitMatches(tx, sourceRunId, finished), false, 'A restarted ordinary source invalidates the saved terminal state');
      await tx.taskRun.update({ where: { id: sourceRunId }, data: { status: 'completed' } });
    });
    await reconcileResourceApprovals(id); await drainResourceApprovals(); assert.equal(turns, 1, 'Pending approval cannot continue');
    const approve = () => decideResourceAccess({ id, revision: 1, actorOpenId: 'runtime-resource-admin', action: 'approve' });
    await Promise.all([approve(), approve()]);
    await Promise.all([reconcileResourceApprovals(id), reconcileResourceApprovals(id)]); await drainResourceApprovals();
    approval = await getResourceApproval(id);
    assert.equal(approval.payload.application.state, 'effective', JSON.stringify(approval.payload.application));
    assert.equal(turns, 2);
    await approve(); await reconcileResourceApprovals(id); await drainResourceApprovals();
    assert.equal(turns, 2, 'Repeated callbacks and recovery retain one continuation');
    const runs = await prisma.taskRun.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' }, include: { participants: true } });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].taskSessionId, runs[1].taskSessionId);
    assert.equal(runs[1].participants[0].role, runs[0].participants[0].role);
    assert.equal(requests[1].native, native); assert.equal(requests[1].cwd, requests[0].cwd); assert.equal(requests[1].role, requests[0].role);
    assert.equal(await readFile(join(output, 'result.txt'), 'utf8'), 'mounted and continued');
    assert.deepEqual(Array.from(new Set(published)), [id], 'Approval updates retain the same card identity');
    const stdout = await prisma.taskRunEvent.findMany({ where: { taskRunId: first.taskRunId, eventType: 'stdout_chunk' } });
    assert.ok(stdout.some(event => event.content.includes('已检查目录')), 'Protocol selection preserves process commentary');
    await resourceWorkspaceRegression();
    await finalOutputRegression(cwd, source);
    console.log('task-resource-runtime passed: real read/write sandbox, native-session continuity without graph Writer, terminal-state recheck and approval replay dedupe');
  } finally {
    await drainResourceApprovals();
    await prisma.feishuAdminApproval.deleteMany({ where: { kind: 'task_resources', payloadJson: { contains: root } } });
    adapter.execute = original.execute; adapter.resume = original.resume; cards.publishResourceApproval = originalPublish;
    await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
