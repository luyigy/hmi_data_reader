import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, unlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { canonicalResourceDirectories, parseResourceInputs, verifyResourceDirectories, resourceCovers, type ResourceLaunch } from '../src/lib/task-resources/model';
import { requestResourceAccess, decideResourceAccess, resolveResourceAccess, updateResourceApplication, getResourceApproval } from '../src/lib/task-resources/access';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  process.env.FEISHU_ADMIN_OPEN_ID = 'resource-admin';
  const root = await mkdtemp(join(tmpdir(), 'task-resources-'));
  const project = join(root, 'project'), extra = join(root, 'extra'), output = join(root, 'output'), other = join(root, 'other');
  await Promise.all([project, extra, output, other].map(path => mkdir(path)));
  try {
    assert.throws(() => parseResourceInputs([{ path: '/', access: 'read' }]));
    assert.throws(() => parseResourceInputs([{ path: 'relative', access: 'write' }]));
    assert.throws(() => parseResourceInputs([{ path: extra, access: 'execute' }]));
    const alias = join(root, 'alias'); await symlink(extra, alias);
    const canonical = await canonicalResourceDirectories([{ path: alias, access: 'read' }]);
    assert.equal(canonical[0].canonicalPath, extra);
    await unlink(alias); await symlink(other, alias);
    await assert.rejects(verifyResourceDirectories(canonical), /identity changed/);
    const nested = join(extra, 'nested'); await mkdir(nested);
    const child = (await canonicalResourceDirectories([{ path: nested, access: 'read' }]))[0];
    assert(resourceCovers({ ...canonical[0], path: extra }, child));
    assert(!resourceCovers({ ...canonical[0], path: extra }, { ...child, access: 'write' }));

    const owner = await prisma.user.create({ data: { username: `resource-${Date.now()}`, passwordHash: 'fixture' } });
    const task = await prisma.task.create({ data: { name: 'resource source', ownerUserId: owner.id, workingDirectory: project } });
    const launch: ResourceLaunch = { taskId: task.id, taskName: task.name, orchestrationMode: 'single', workingDirectory: project,
      participants: [{ gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', agentId: 'fixture' }] };
    const request = { launch, requesterOpenId: 'ordinary-user', requesterChatId: 'fixture-chat', purpose: 'Read dependency', resources: [{ path: extra, access: 'read' as const }] };
    const [a, b] = await Promise.all([requestResourceAccess(request), requestResourceAccess(request)]);
    assert(a.kind === 'request' && b.kind === 'request'); assert.equal(a.approval.id, b.approval.id);
    const id = a.approval.id;
    await assert.rejects(decideResourceAccess({ id, revision: 1, actorOpenId: 'ordinary-user', action: 'approve' }), /administrator/);
    const revised = await decideResourceAccess({ id, revision: 1, actorOpenId: 'resource-admin', action: 'replace', resources: [{ path: extra, access: 'read' }, { path: output, access: 'write' }] });
    assert.equal(revised.payload.revision, 2); assert.equal(revised.payload.proposalHistory?.length, 1);
    await assert.rejects(decideResourceAccess({ id, revision: 1, actorOpenId: 'resource-admin', action: 'approve' }), /stale/);
    await decideResourceAccess({ id, revision: 2, actorOpenId: 'resource-admin', action: 'approve' });
    await decideResourceAccess({ id, revision: 2, actorOpenId: 'resource-admin', action: 'approve' });
    assert.equal((await getResourceApproval(id)).payload.decisions?.length, 2);
    await prisma.feishuAdminApproval.update({ where: { id }, data: { expiresAt: new Date(0) } });
    assert.equal((await resolveResourceAccess(launch)).resources.length, 2);
    assert.equal((await requestResourceAccess(request)).kind, 'covered');
    const changedRole = { ...launch, participants: [{ ...launch.participants[0], role: 'acceptance' }] };
    assert.deepEqual(await resolveResourceAccess(changedRole), { approvalIds: [], resources: [] });
    await updateResourceApplication(id, { state: 'scheduled', runId: 'first' });
    await assert.rejects(updateResourceApplication(id, { state: 'scheduled', runId: 'second' }), /another run/);
    await assert.rejects(updateResourceApplication(id, { state: 'effective', runId: 'second' }), /another run/);
    await updateResourceApplication(id, { state: 'failed', detail: 'fixture mount failure' });
    assert.equal((await getResourceApproval(id)).status, 'approved');
    await updateResourceApplication(id, { state: 'scheduled', runId: 'retry' });
    await updateResourceApplication(id, { state: 'effective', runId: 'retry' });
    await decideResourceAccess({ id, revision: 2, actorOpenId: 'resource-admin', action: 'revoke' });
    assert.deepEqual(await resolveResourceAccess(launch), { approvalIds: [], resources: [] });
    await assert.rejects(updateResourceApplication(id, { state: 'effective' }), /Revoked/);
    await updateResourceApplication(id, { state: 'revoked' });

    assert.equal((await getResourceApproval(id)).payload.decisions?.[1].action, 'approve');
    assert.equal((await getResourceApproval(id)).payload.decisions?.[2].action, 'revoke');
    const baseCovered = await requestResourceAccess({ ...request, launch: { ...launch, extraReadOnlyPaths: [extra] } });
    assert.equal(baseCovered.kind, 'covered');
    const denied = await requestResourceAccess({ ...request, purpose: 'denied intent' }); assert(denied.kind === 'request');
    await decideResourceAccess({ id: denied.approval.id, revision: 1, actorOpenId: 'resource-admin', action: 'deny' });
    const duplicateDenied = await requestResourceAccess({ ...request, purpose: 'denied intent' }); assert(duplicateDenied.kind === 'request');
    assert.equal(duplicateDenied.approval.id, denied.approval.id); assert.equal(duplicateDenied.approval.status, 'denied');

    const projectGrant = await requestResourceAccess({ ...request, purpose: 'project library', scope: 'project' }); assert(projectGrant.kind === 'request');
    await decideResourceAccess({ id: projectGrant.approval.id, revision: 1, actorOpenId: 'resource-admin', action: 'approve' });
    const sibling = await prisma.task.create({ data: { name: 'same owner', ownerUserId: owner.id, workingDirectory: project } });
    assert.equal((await resolveResourceAccess({ ...launch, taskId: sibling.id })).resources.length, 1);
    const unowned = await prisma.task.create({ data: { name: 'no owner', workingDirectory: project } });
    assert.equal((await resolveResourceAccess({ ...launch, taskId: unowned.id })).resources.length, 0);
    await assert.rejects(requestResourceAccess({ ...request, launch: { ...launch, taskId: unowned.id }, scope: 'project' }), /persisted project owner/);
    await assert.rejects(requestResourceAccess({ ...request, launch: { ...launch, participants: [{ ...launch.participants[0], executionBackend: 'remote_ssh' }] } }), /platform-local/);

    const graphRun = await prisma.taskGraphRun.create({ data: { parentTaskId: task.id, version: 1, requestKey: task.id, snapshotHash: 'fixture', snapshot: {} } });
    const node = await prisma.taskGraphNode.create({ data: { runId: graphRun.id, key: 'one', dependsOn: [], acceptance: 'automatic' } });
    const graphTask = await prisma.task.create({ data: { name: 'graph child', workingDirectory: output } });
    const execution = await prisma.taskGraphExecution.create({ data: { nodeId: node.id, key: 'one', repository: project, gitRef: 'main', baseCommit: 'fixture', agentSelector: 'local:codex', childTaskId: graphTask.id, worktreePath: output } });
    const graphLaunch = { ...launch, taskId: graphTask.id, workingDirectory: output, graphExecution: { executionId: execution.id, claimToken: 'fixture', revision: 1 } };
    const siblingWrite = await requestResourceAccess({ ...request, launch: graphLaunch, resources: [{ path: other, access: 'write' }] });
    assert.equal(siblingWrite.kind, 'request', 'An explicit sibling repository edit must produce a pending card, not fail before approval');
    await assert.rejects(requestResourceAccess({ ...request, launch: { ...graphLaunch, graphConversation: { executionId: execution.id, reservationId: 'fixture', inputIds: [] } }, resources: [{ path: other, access: 'write' }] }), /implementation turn/);
    await assert.rejects(requestResourceAccess({ ...request, resources: [{ path: output, access: 'write' }] }), /another graph execution/);
    const own = await requestResourceAccess({ ...request, launch: graphLaunch, resources: [{ path: output, access: 'write' }] }); assert.equal(own.kind, 'covered');
    assert.equal((await resolveResourceAccess(graphLaunch)).resources.length, 1);
    await prisma.taskGraphRun.delete({ where: { id: graphRun.id } });
    await rename(extra, join(root, 'old-extra')); await mkdir(extra);
    await assert.rejects(resolveResourceAccess(launch), /identity changed/);
    console.log('task-resource-access tests passed');
  } finally { await prisma.feishuAdminApproval.deleteMany({ where: { kind: 'task_resources', payloadJson: { contains: root } } }); await rm(root, { recursive: true, force: true }); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
