import { projectCapabilityContext } from '../src/lib/project-capabilities/context';
import { prepareResourceWorkspaces } from '../src/lib/task-resources/graph-workspace';
import type { TaskInputManifest } from '../src/lib/task-graph/upstream-inputs';
import { createGraphWriter, releaseTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { ensureGraphRoomParticipants } from '../src/lib/task-graph/conversation-members';
import { migrateGraphRoomPermissions } from '../src/lib/task-graph/room-permission-migration';
import { taskGraphAgentReviewPermissionConfig } from '../src/lib/task-graph/review-permissions';
import { setLiveRoomMemberPermission } from '../src/lib/live-room-permissions';
import { buildAcpxPermissionConfigForProfile } from '../src/lib/acpx/permissions';
import { getHarnessAdapter } from '../src/lib/harness';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import { requestResourceAccess, decideResourceAccess, resolveResourceAccess } from '../src/lib/task-resources/access';
import { runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { projectCapabilityPolicy } from '../src/lib/project-capabilities/policy';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';
import type { AcpxRunRequest } from '../src/lib/acpx/types';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const root = await mkdtemp(join(tmpdir(), 'thin-room-resources-'));
  process.env.TASK_GRAPH_UPSTREAM_ROOT = join(root, 'upstream');
  process.env.TASK_GRAPH_RUNTIME_ROOT = join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = join(root, 'validation');
  process.env.FEISHU_ADMIN_OPEN_ID = 'resource-admin'; process.env.FEISHU_APP_ID = 'cli_fixture';
  const repository = join(root, 'repository'), review = join(root, 'review'), extra = join(root, 'extra'), hidden = join(root, 'hidden'), tools = join(root, 'tools');
  for (const dir of [repository, review, extra, hidden, tools]) await mkdir(dir);
  await writeFile(join(hidden, 'secret'), 'private'); await writeFile(join(tools, 'authorized'), 'tool');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  await writeFile(join(repository, 'server.cjs'), `require('http').createServer((q,s)=>s.end('healthy')).listen(Number(process.argv[3]),process.argv[2])`);
  await writeFile(join(repository, 'source'), 'candidate'); git('add', '.'); git('commit', '-m', 'candidate'); const commit = git('rev-parse', 'HEAD');
  const serviceRepository = join(root, 'service-repo'); execFileSync('git', ['clone', repository, serviceRepository], { stdio: 'pipe' });
  const owner = await prisma.user.create({ data: { username: `thin-${Date.now()}`, passwordHash: 'fixture' } });
  const parent = await prisma.task.create({ data: { name: 'resources', ownerUserId: owner.id } });
  const interpreter = await realpath(process.execPath), script = join(tools, 'verify.cjs');
  await writeFile(script, "require('fs').writeFileSync(process.env.AP_GRAPH_OUTPUT_DIR+'/test-result.json', JSON.stringify({passed:true,commit:process.env.TEST_COMMIT}));");
  const runtime = { version: 2, resources: [{ id: 'node', resource: { path: interpreter, sha256: await runtimeResourceDigest(interpreter) } },
    { id: 'verify', resource: { path: script, sha256: await runtimeResourceDigest(script) } }], validation: { interpreter: 'node', script: 'verify', args: [] } };
  const policyFile = join(root, 'policies.json');
  await writeFile(policyFile, JSON.stringify({ version: 1, projects: [{ repository, appId: 'cli_fixture', principals: [`platform:${owner.id}`], sources: [], readOnlyRoots: [tools, dirname(interpreter)], runtime }] }));
  const policies = require('../src/lib/project-capabilities/policy'); const originalPolicy = policies.projectCapabilityPolicy;
  policies.projectCapabilityPolicy = (repo: string) => originalPolicy(repo, policyFile);
  const policy = (await projectCapabilityPolicy(repository, policyFile))!;
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', agentId: 'codex', role: 'implementer' };
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://resources', nodes: [{ key: 'A', goal: 'service', dependsOn: [], acceptance: { mode: 'automatic', checks: ['fixture'] },
    executions: [{ key: 'service', repository: serviceRepository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture' }] },
    { key: 'T', goal: 'resources', dependsOn: ['A'], services: [{ key: 'fixture-service', input: 'A/service', runtime: 'node', entry: 'server.cjs', args: ['127.0.0.1', '{port}', '{data}'], healthPath: '/', startupTimeoutMs: 3000 }],
    acceptance: { mode: 'agent', checks: ['fixture'], reviewerId: 'local:codex', reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } },
    executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant }, capabilities: { policyHash: policy.hash, sources: [], readOnlyRoots: policy.readOnlyRoots } }] }] } });
  const upstream = await prisma.taskGraphNode.findFirstOrThrow({ where: { runId: graph.id, key: 'A' } });
  await prisma.taskGraphNode.update({ where: { id: upstream.id }, data: { status: 'passed' } });
  await prisma.taskGraphExecution.updateMany({ where: { nodeId: upstream.id }, data: { status: 'integrated', commit } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id, key: 'T' } } });
  const permission = buildAcpxPermissionConfigForProfile('dev_local', [repository]);
  const child = await prisma.task.create({ data: { name: 'ordinary-id-child', workingDirectory: repository, acpxPermissionConfig: JSON.stringify(permission) } });
  await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: repository, status: 'attention' } });
  const reviewTask = await prisma.task.create({ data: { name: 'ordinary-id-review', workingDirectory: review, acpxPermissionConfig: JSON.stringify(buildAcpxPermissionConfigForProfile('dev_local', [review])) } });
  const writer = await createGraphWriter();
  const historical = await prisma.taskRun.create({ data: { participants: { create: { ...participant, role: 'tester', gatewayNameSnapshot: 'local' } }, taskId: reviewTask.id, mode: 'acpx', status: 'completed', controlMetadata: JSON.stringify({ graphWriter: writer, graphReview: { runId: graph.id, nodeId: job.nodeId }, reviewCandidates: [{ id: job.id, commit }] }) } });
  await releaseTaskRunWriter(historical.id, writer.nonce);
  const capabilities = require('../src/lib/project-capabilities/runtime');
  const withCapabilities = capabilities.withProjectCapabilities;
  capabilities.withProjectCapabilities = (args: any, action: any) => withCapabilities({ ...args, root: join(root, 'capabilities') }, action);
  const reviewLaunch: AcpxRunRequest = { taskId: reviewTask.id, taskName: 'review', workingDirectory: review, orchestrationMode: 'single',
    participants: [{ ...participant, role: 'tester' }], permissionConfig: buildAcpxPermissionConfigForProfile('dev_local', [review]), extraReadOnlyPaths: [repository] };
  const grant = await requestResourceAccess({ launch: reviewLaunch, requesterOpenId: 'fixture', requesterChatId: 'fixture', purpose: 'review writes', resources: [{ path: extra, access: 'write' }, { path: repository, access: 'write' }] });
  assert.equal(grant.kind, 'request'); if (grant.kind !== 'request') throw new Error('Expected new authorization');
  assert.equal((await resolveResourceAccess(reviewLaunch)).resources.length, 0, 'Pending permissions are not effective');
  await decideResourceAccess({ id: grant.approval.id, revision: 1, actorOpenId: 'resource-admin', action: 'approve' });
  assert.equal((await resolveResourceAccess(reviewLaunch)).resources.length, 2);
  const approved = (await resolveResourceAccess(reviewLaunch)).resources;
  const baseInput = { repository, commit, sourcePath: repository, executions: ['T/repo'], resultsDirectories: [], dependencyPaths: [], quality: ['passed'], projectEnvPath: null, pythonExecutable: null };
  const manifest: TaskInputManifest = { version: 1, executionId: job.id, primaryRepository: repository, hash: 'fixture', inputs: [baseInput] };
  await assert.rejects(prepareResourceWorkspaces(reviewLaunch, approved, [manifest, { ...manifest, inputs: [{ ...baseInput, commit: 'f'.repeat(40) }] }]), /多个固定版本/);
  const readOnly = { ...reviewLaunch, permissionConfig: { ...reviewLaunch.permissionConfig!, sandboxMode: 'read-only' as const } };
  assert((await resolveResourceAccess(readOnly)).resources.every(item => item.access === 'read'), 'Explicit read-only wins over old write grants');
  const unrelated = await prisma.task.create({ data: { name: 'task-graph-fake', workingDirectory: review } });
  assert.equal((await resolveResourceAccess({ ...reviewLaunch, taskId: unrelated.id })).resources.length, 0);
  await assert.rejects(requestResourceAccess({ launch: { ...reviewLaunch, taskId: unrelated.id }, requesterOpenId: 'fixture', requesterChatId: 'fixture', purpose: 'cross task', resources: [{ path: repository, access: 'write' }] }), /another graph execution/);
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => ({ projects: [] });
  require('../src/lib/scheduled-jobs/runner').wakeWorkflowWatcherForTaskRun = async () => { throw new Error('Graph run woke watcher'); };
  const adapter = getHarnessAdapter('codex')!, originalExecute = adapter.execute;
  let probes = 0; const serviceUrls: string[] = [];
  adapter.execute = async args => {
    probes++;
    const context = args.context, ro = context.permissionConfig?.sandboxMode === 'read-only';
    assert(context.extraReadOnlyPaths?.includes(tools), 'Project policy tools reach the harness');
    const service = JSON.parse(context.taskEnvironment!.TASK_GRAPH_SERVICES_JSON)[0];
    assert.equal(await (await fetch(service.url)).text(), 'healthy'); serviceUrls.push(service.url);
    const validation = JSON.parse(context.taskEnvironment!.AP_GRAPH_RUNTIME_VALIDATION_JSON);
    const script = `const fs=require('fs'),a=require('assert/strict'),cp=require('child_process');
      a.equal(fs.existsSync(${JSON.stringify(join(hidden, 'secret'))}),false);
      a.equal(fs.readFileSync(${JSON.stringify(join(tools, 'authorized'))},'utf8'),'tool');
      a.throws(()=>fs.writeFileSync(${JSON.stringify(join(tools, 'forbidden'))},'no'));
      ${ro ? `a.throws(()=>fs.writeFileSync(${JSON.stringify(join(review, 'write'))},'no'));a.throws(()=>fs.writeFileSync(${JSON.stringify(join(extra, 'write'))},'no'));a.throws(()=>fs.writeFileSync(${JSON.stringify(join(repository, 'source'))},'no'));` : `fs.writeFileSync(${JSON.stringify(join(review, 'write'))},'ok');fs.writeFileSync(${JSON.stringify(join(extra, 'write'))},'ok');fs.writeFileSync(${JSON.stringify(join(repository, 'source'))},'approved-edit');`}
      cp.execFileSync(${JSON.stringify(validation.argv[0])},${JSON.stringify(validation.argv.slice(1))},{env:{...process.env,TEST_COMMIT:${JSON.stringify(commit)}}});`;
    const plan = prepareSandboxEnvironment({ command: process.execPath, commandArgs: ['-e', script], cwd: review, workspaceRoot: review,
      writableRoots: context.extraWritableRoots, readOnlyPaths: context.extraReadOnlyPaths, sandboxMode: context.permissionConfig?.sandboxMode,
      networkAccess: 'restricted', env: { ...process.env, ...context.taskEnvironment } });
    const command = renderBubblewrap(plan), child = spawn(command.command, command.args, { cwd: review, env: plan.env, stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); const exit = once(child, 'exit'); context.onSpawn?.(child);
    assert.equal((await exit)[0], 0, stderr);
    const report = JSON.parse(await readFile(join(context.taskEnvironment!.AP_GRAPH_OUTPUT_DIR, 'test-result.json'), 'utf8'));
    assert.deepEqual(report, { passed: true, commit });
    return { success: true, output: '实际测试完成，尚无正式验收结果', executionTime: 1 };
  };
  try {
    assert.equal((await executeAcpxTaskRun(reviewLaunch)).status, 'completed');
    assert.equal((await executeAcpxTaskRun(readOnly)).status, 'completed');
    assert.equal(probes, 2);
    for (const url of serviceUrls) await assert.rejects(fetch(url), /fetch failed/, 'Attempt service must close after each human turn');
    const receipts = await prisma.taskGraphEvent.findMany({ where: { nodeId: job.nodeId, kind: 'room_runtime_prepared' } });
    assert.equal(receipts.length, 2); assert.equal((receipts[0].payload as any).sources[0].commit, commit);
    console.log('Arbitrary task IDs and real declared service startup/cleanup: project tools, approved tester source/extra writes, read-only override, actual sandbox test output and source receipt passed');

    const room = await prisma.liveRoom.create({ data: { sourceTaskId: child.id, ownerUserId: owner.id, title: 'migration' } });
    const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'owner request' } });
    assert(await projectCapabilityContext({ taskId: reviewTask.id, workspace: review, roomMessageId: message.id }));
    const outsider = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'outsider request', metadata: JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'ou_outsider' }) } });
    await assert.rejects(projectCapabilityContext({ taskId: reviewTask.id, workspace: review, roomMessageId: outsider.id }), /未获项目能力授权/);
    const members = await ensureGraphRoomParticipants(room.id, job.id); const member = members.find(item => item.role === 'implementer')!;
    assert.equal((await migrateGraphRoomPermissions(room.id))[0].decision, 'already_inherited');
    const legacy = JSON.stringify(taskGraphAgentReviewPermissionConfig);
    await prisma.liveRoomMember.update({ where: { id: member.id }, data: { acpxPermissionConfig: legacy } });
    assert.equal((await migrateGraphRoomPermissions(room.id))[0].decision, 'ambiguous');
    const current = await prisma.liveRoomMember.findUniqueOrThrow({ where: { id: member.id } });
    await prisma.taskGraphEvent.update({ where: { runId_idempotencyKey: { runId: graph.id, idempotencyKey: `room-permission-origin:${member.id}` } }, data: { payload: {
      source: 'graph_participant_default_v1', memberId: member.id, roomId: room.id, taskId: child.id, permission: legacy,
      createdAt: current.createdAt.toISOString(), updatedAt: current.updatedAt.toISOString() } } }); // Isolated historical receipt fixture only.
    const dry = await migrateGraphRoomPermissions(room.id); assert.equal(dry[0].decision, 'inherit');
    assert.equal((await prisma.liveRoomMember.findUniqueOrThrow({ where: { id: member.id } })).acpxPermissionConfig, legacy);
    // Force a write failure after the member update: the entire transaction must roll back.
    const create = prisma.$transaction.bind(prisma);
    (prisma as any).$transaction = (action: any) => create(async tx => { const actual = tx.taskGraphEvent.create.bind(tx.taskGraphEvent);
      (tx.taskGraphEvent as any).create = (args: any) => args.data.kind === 'room_member_permission_migrated' ? Promise.reject(new Error('fixture audit failure')) : actual(args);
      return action(tx); });
    await assert.rejects(migrateGraphRoomPermissions(room.id, true), /fixture audit failure/); (prisma as any).$transaction = create;
    assert.equal((await prisma.liveRoomMember.findUniqueOrThrow({ where: { id: member.id } })).acpxPermissionConfig, legacy);
    assert.equal((await migrateGraphRoomPermissions(room.id, true))[0].decision, 'inherit');
    assert.equal((await migrateGraphRoomPermissions(room.id, true))[0].decision, 'already_inherited');
    assert.equal(await prisma.taskGraphEvent.count({ where: { kind: 'room_member_permission_migrated', nodeId: job.nodeId } }), 1);
    await setLiveRoomMemberPermission(room.id, member.id, 'safe_local');
    assert.equal((await migrateGraphRoomPermissions(room.id, true))[0].decision, 'preserve');
    assert.equal(await prisma.taskGraphEvent.count({ where: { kind: 'room_member_permission_changed', nodeId: job.nodeId } }), 1);
    const reviewer = members.find(item => item.role === 'tester')!;
    assert.deepEqual((await setLiveRoomMemberPermission(room.id, reviewer.id, 'safe_local')).writableRoots, [review], 'Permission UI inherits the registered reviewer task, not the implementation workspace');
    console.log('Migration: missing provenance preserved, exact default restored from verified task, dry-run unchanged, atomic rollback, idempotent second apply, user edits retained');
  } finally { adapter.execute = originalExecute; policies.projectCapabilityPolicy = originalPolicy; await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
