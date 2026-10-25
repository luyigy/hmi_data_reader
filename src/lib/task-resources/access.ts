import type { Prisma } from '@prisma/client';
import { realpath } from 'node:fs/promises';
import { prisma } from '../prisma';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../acpx/permissions';
import {
  canonicalResourceDirectories, directoryContains, resourceCovers, resourceHostIdentity, resourceIntentHash, resourcePrincipal, verifyResourceDirectories,
  type ResourceApproval, type ResourceApplication, type ResourceDirectory, type ResourceInput, type ResourceLaunch, type ResourcePayload, type ResourceSource,
} from './model';

type DB = Prisma.TransactionClient;

function decode(row: { id: string; kind: string; status: string; requesterOpenId: string; requesterChatId: string; cardMessageId: string | null; expiresAt: Date | null; payloadJson: string | null }): ResourceApproval {
  if (row.kind !== 'task_resources' || !row.payloadJson) throw new Error('Not a task resource approval.');
  const payload = JSON.parse(row.payloadJson) as ResourcePayload;
  if (payload.version !== 1 || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || !payload.hostIdentity || !payload.ownerKey || !Array.isArray(payload.resources)) throw new Error('Invalid resource approval payload.');
  resourcePrincipal(payload.launch);
  return { id: row.id, status: row.status, requesterOpenId: row.requesterOpenId, requesterChatId: row.requesterChatId, cardMessageId: row.cardMessageId, expiresAt: row.expiresAt, payload };
}

export async function getResourceApproval(id: string, tx: DB = prisma): Promise<ResourceApproval> {
  return decode(await tx.feishuAdminApproval.findUniqueOrThrow({ where: { id } }));
}

export async function lockResourceApproval(tx: DB, id: string): Promise<ResourceApproval> {
  await tx.$queryRaw`SELECT id FROM "FeishuAdminApproval" WHERE id = ${id} FOR UPDATE`;
  return getResourceApproval(id, tx);
}

async function authority(launch: ResourceLaunch, db: DB) {
  resourcePrincipal(launch);
  const task = await db.task.findUniqueOrThrow({ where: { id: launch.taskId } });
  const graph = await db.taskGraphExecution.findUnique({ where: { childTaskId: task.id }, include: { node: { include: { run: { include: { parentTask: true } } } } } });
  const ownerId = graph?.node.run.parentTask.ownerUserId || task.ownerUserId;
  const ownerKey = ownerId ? `user:${ownerId}` : `task:${task.id}`;
  const project = graph?.repository || task.workingDirectory;
  const projectPath = project ? await realpath(project) : undefined;
  return { task, graph, ownerKey, projectPath };
}

async function assertGraphWrites(launch: ResourceLaunch, resources: ResourceDirectory[], db: DB) {
  const writes = resources.filter(resource => resource.access === 'write');
  if (!writes.length) return;
  const { graph } = await authority(launch, db);
  const executions = await db.taskGraphExecution.findMany({ where: { worktreePath: { not: null } }, select: { id: true, worktreePath: true } });
  for (const execution of executions) {
    const worktree = await realpath(execution.worktreePath!).catch(() => execution.worktreePath!);
    if (execution.id !== graph?.id && writes.some(resource => directoryContains(resource.canonicalPath, worktree) || directoryContains(worktree, resource.canonicalPath))) {
      throw new Error('Resource access cannot grant another graph execution worktree write ownership.');
    }
  }
  if (!graph && !launch.graphExecution && !launch.graphConversation && !launch.graphReview) return;
  if (!graph?.worktreePath || launch.graphReview || launch.graphConversation) throw new Error('Graph resource writes require an implementation turn.');
  const own = await realpath(graph.worktreePath);
  if (writes.some(resource => resource.canonicalPath !== own && directoryContains(resource.canonicalPath, own))) throw new Error('Resource writes cannot include the execution workspace parent.');
  if (launch.graphExecution && launch.graphExecution.executionId !== graph.id) throw new Error('Graph resource execution identity mismatch.');
}

async function findGrants(launch: ResourceLaunch, db: DB) {
  const current = await authority(launch, db);
  const host = await resourceHostIdentity();
  const principal = JSON.stringify(resourcePrincipal(launch));
  const rows = await db.feishuAdminApproval.findMany({ where: { kind: 'task_resources', status: 'approved' } });
  const approvals: ResourceApproval[] = [];
  for (const row of rows) {
    const approval = decode(row);
    const payload = approval.payload;
    if (payload.hostIdentity !== host || payload.ownerKey !== current.ownerKey || JSON.stringify(resourcePrincipal(payload.launch)) !== principal) continue;
    if (payload.scope === 'task' ? payload.launch.taskId !== launch.taskId : !current.projectPath || payload.projectPath !== current.projectPath || !current.ownerKey.startsWith('user:')) continue;
    await verifyResourceDirectories(payload.resources);
    await assertGraphWrites(launch, payload.resources, db);
    approvals.push(approval);
  }
  return approvals;
}

export async function resolveResourceAccess(launch: ResourceLaunch): Promise<{ approvalIds: string[]; resources: ResourceDirectory[] }> {
  return prisma.$transaction(async tx => {
    const approvals = await findGrants(launch, tx);
    const resources = new Map<string, ResourceDirectory>();
    for (const approval of approvals) for (const resource of approval.payload.resources) {
      if (!resources.has(resource.canonicalPath) || resource.access === 'write') resources.set(resource.canonicalPath, resource);
    }
    return { approvalIds: approvals.map(approval => approval.id), resources: Array.from(resources.values()) };
  });
}

export async function requestResourceAccess(args: {
  launch: ResourceLaunch; source?: ResourceSource; requesterOpenId: string; requesterChatId: string;
  purpose: string; resources: ResourceInput[]; scope?: 'task' | 'project'; projectPath?: string;
}): Promise<{ kind: 'covered' } | { kind: 'request'; approval: ResourceApproval }> {
  if (!args.requesterOpenId?.trim() || !args.purpose?.trim() || args.purpose.length > 4000) throw new Error('Resource request requires requester and purpose.');
  if (args.launch.participants.some(p => p.harnessType !== 'codex')) throw new Error('Resource continuation currently requires the local Codex startup barrier.');
  const resources = await canonicalResourceDirectories(args.resources);
  const hostIdentity = await resourceHostIdentity();
  return prisma.$transaction(async tx => {
    const context = await authority(args.launch, tx);
    if (context.task.status === 'completed') throw new Error('Completed tasks cannot request new resources.');
    if (args.scope && !['task', 'project'].includes(args.scope)) throw new Error('Invalid resource scope.');
    const scope = args.scope || 'task';
    if (scope === 'project' && (!context.ownerKey.startsWith('user:') || !context.projectPath)) throw new Error('Project resource reuse requires a persisted project owner and directory.');
    if (args.projectPath && await realpath(args.projectPath) !== context.projectPath) throw new Error('Resource project identity does not match the task.');
    if (args.source) {
      const source = await tx.taskRunParticipant.findUniqueOrThrow({ where: { id: args.source.participantId }, include: { taskRun: true } });
      if (source.taskRunId !== args.source.taskRunId || source.taskRun.taskId !== args.launch.taskId || (source.taskRun.taskSessionId || undefined) !== args.launch.taskSessionId || JSON.stringify(resourcePrincipal({ ...args.launch, participants: [{ gatewayId: source.gatewayId || '', executionBackend: source.executionBackend as 'platform_local', harnessType: source.harnessType as ResourceLaunch['participants'][number]['harnessType'], role: source.role, agentId: source.agentId || undefined }] })) !== JSON.stringify(resourcePrincipal(args.launch))) throw new Error('Resource source does not match the task participant.');
    }
    await assertGraphWrites(args.launch, resources, tx);
    const base = { launch: args.launch, hostIdentity, ownerKey: context.ownerKey, resources, scope, projectPath: context.projectPath, purpose: args.purpose.trim() };
    const requestHash = resourceIntentHash(base);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`task-resources:${requestHash}`}, 0))`;
    const grants = await findGrants(args.launch, tx);
    const permission = args.launch.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG;
    if (permission.profile === 'full_access') return { kind: 'covered' as const };
    const baseInputs: ResourceInput[] = [
      ...Array.from(new Set([...permission.writableRoots, ...(args.launch.workingDirectory ? [args.launch.workingDirectory] : [])]))
        .map(path => ({ path, access: permission.sandboxMode === 'read-only' ? 'read' as const : 'write' as const })),
      ...(args.launch.extraReadOnlyPaths || []).map(path => ({ path, access: 'read' as const })),
    ];
    const baseResources = baseInputs.length ? await canonicalResourceDirectories(baseInputs) : [];
    const missing = resources.filter(resource => !baseResources.some(base => resourceCovers(base, resource)) && !grants.some(grant => grant.payload.resources.some(approved => resourceCovers(approved, resource))));
    if (!missing.length) return { kind: 'covered' as const };
    const existing = await tx.feishuAdminApproval.findMany({ where: { kind: 'task_resources', status: { in: ['pending', 'denied'] } }, orderBy: { createdAt: 'desc' } });
    for (const row of existing) {
      const approval = decode(row);
      if (approval.payload.requestHash !== requestHash) continue;
      if (approval.status === 'denied' || !approval.expiresAt || approval.expiresAt > new Date()) return { kind: 'request' as const, approval };
      await tx.feishuAdminApproval.update({ where: { id: row.id }, data: { status: 'expired' } });
    }
    const payload: ResourcePayload = { ...base, resources: missing, version: 1, revision: 1, requestHash, source: args.source, application: { state: 'waiting' } };
    const row = await tx.feishuAdminApproval.create({ data: { kind: 'task_resources', requesterOpenId: args.requesterOpenId, requesterChatId: args.requesterChatId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), payloadJson: JSON.stringify(payload) } });
    return { kind: 'request' as const, approval: decode(row) };
  });
}

export async function decideResourceAccess(args: { id: string; revision: number; actorOpenId: string; action: 'approve' | 'deny' | 'replace' | 'revoke'; resources?: ResourceInput[]; scope?: 'task' | 'project' }): Promise<ResourceApproval> {
  if (!args.actorOpenId || args.actorOpenId !== process.env.FEISHU_ADMIN_OPEN_ID?.trim()) throw new Error('Only the configured Feishu administrator may decide resource access.');
  if (!['approve', 'deny', 'replace', 'revoke'].includes(args.action)) throw new Error('Invalid resource decision.');
  return prisma.$transaction(async tx => {
    const approval = await lockResourceApproval(tx, args.id);
    const payload = approval.payload;
    if (payload.revision !== args.revision) throw new Error('This resource approval version is stale.');
    const target = args.action === 'approve' ? 'approved' : args.action === 'deny' ? 'denied' : args.action === 'revoke' ? 'revoked' : 'pending';
    if (args.action !== 'replace' && approval.status === target) return approval;
    if (args.action === 'revoke') {
      if (approval.status !== 'approved') throw new Error('Only approved resource access can be revoked.');
      payload.application = { ...payload.application, state: 'revoking' };
    } else {
      if (approval.status !== 'pending') throw new Error('This resource request has already been decided.');
      if (approval.expiresAt && approval.expiresAt <= new Date()) throw new Error('This resource approval has expired.');
      if (args.action !== 'deny') {
        if (payload.hostIdentity !== await resourceHostIdentity()) throw new Error('Resource host identity changed.');
        const context = await authority(payload.launch, tx);
        if (context.ownerKey !== payload.ownerKey || context.projectPath !== payload.projectPath) throw new Error('Resource ownership changed.');
        if (context.task.status === 'completed') throw new Error('Completed tasks cannot receive new resource grants.');
        if (args.action === 'replace') {
          if (args.scope && !['task', 'project'].includes(args.scope)) throw new Error('Invalid resource scope.');
          const resources = await canonicalResourceDirectories(args.resources || payload.resources);
          const scope = args.scope || payload.scope;
          if (scope === 'project' && (!payload.ownerKey.startsWith('user:') || !payload.projectPath)) throw new Error('Project resource reuse requires a persisted project owner and directory.');
          payload.proposalHistory = [...payload.proposalHistory || [], { revision: payload.revision, requestHash: payload.requestHash, resources: payload.resources, scope: payload.scope }];
          payload.resources = resources; payload.scope = scope; payload.revision += 1;
          payload.requestHash = resourceIntentHash(payload);
        }
        await verifyResourceDirectories(payload.resources);
        await assertGraphWrites(payload.launch, payload.resources, tx);
      }
    }
    payload.decisions = [...payload.decisions || [], { revision: payload.revision, action: args.action, actorOpenId: args.actorOpenId, at: new Date().toISOString() }];
    const row = await tx.feishuAdminApproval.update({ where: { id: args.id }, data: { status: target, payloadJson: JSON.stringify(payload),
      ...(args.action === 'replace' ? {} : { resolvedBy: args.actorOpenId, resolvedAt: new Date() }) } });
    return decode(row);
  });
}

const transitions: Record<ResourceApplication['state'], ResourceApplication['state'][]> = {
  waiting: ['waiting', 'scheduled', 'failed'], scheduled: ['scheduled', 'effective', 'failed'],
  effective: ['effective', 'failed'], failed: ['failed', 'scheduled'], revoking: ['revoking', 'revoked'], revoked: ['revoked'],
};

export async function updateResourceApplication(id: string, application: ResourceApplication, tx?: DB): Promise<void> {
  if (!tx) return prisma.$transaction(db => updateResourceApplication(id, application, db));
  const approval = await lockResourceApproval(tx, id);
  if (approval.status !== 'approved' && approval.status !== 'revoked') throw new Error('Application progress requires an approved or revoked resource decision.');
  if (approval.status === 'revoked' && !['revoking', 'revoked'].includes(application.state)) throw new Error('Revoked resource access cannot become effective again.');
  if (!transitions[approval.payload.application.state]?.includes(application.state)) throw new Error('Invalid resource application transition.');
  if (!(approval.payload.application.state === 'failed' && application.state === 'scheduled') && approval.payload.application.runId && application.runId && approval.payload.application.runId !== application.runId) throw new Error('Resource application is already reserved for another run.');
  if (JSON.stringify(approval.payload.application) === JSON.stringify({ ...approval.payload.application, ...application })) return;
  approval.payload.applicationHistory = [...approval.payload.applicationHistory || [], approval.payload.application];
  approval.payload.application = { ...approval.payload.application, ...application };
  await tx.feishuAdminApproval.update({ where: { id }, data: { payloadJson: JSON.stringify(approval.payload) } });
}

export async function recordResourceDelivery(id: string, delivery: NonNullable<ResourcePayload['delivery']>) {
  return prisma.$transaction(async tx => {
    const approval = await lockResourceApproval(tx, id);
    approval.payload.delivery = { ...approval.payload.delivery, ...delivery };
    await tx.feishuAdminApproval.update({ where: { id }, data: { payloadJson: JSON.stringify(approval.payload) } });
  });
}
