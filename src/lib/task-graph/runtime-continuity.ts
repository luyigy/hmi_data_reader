import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import type { AcpxPermissionConfig } from '../acpx/types';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../acpx/permissions';
import { resolveLocalRuntimeReadOnlyPaths } from '../acpx/runtime-environments';
import { hostRuntimeRegistration } from './runtime-registration';
import { executionProgress } from './execution-progress';
import { graphGit } from './git-command';
import { parseRuntimeDeclaration, runtimeDeclaration, type RuntimeDeclarationSource } from './runtime-contract';
import { prepareDeclaredRuntime, RuntimePreparationError, type PreparedRuntime } from './runtime-preflight';

type Arguments = Parameters<typeof prepareDeclaredRuntime>[0] & { taskId?: string; permissionConfig?: AcpxPermissionConfig };
type Pin = { version: 1; executionId: string; claimToken: string; sourceRepository: string; source: RuntimeDeclarationSource | null; projectManifestHash: string | null; hostReadOnlyRoots: string[]; grantHash: string; identity: string; receipt: PreparedRuntime['receipt'] };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
function parsePin(value: unknown): Pin {
  const pin = record(value), source = record(pin.source);
  if (pin.version !== 1 || typeof pin.executionId !== 'string' || typeof pin.claimToken !== 'string' || typeof pin.sourceRepository !== 'string' || typeof pin.identity !== 'string' || typeof pin.grantHash !== 'string' || pin.projectManifestHash !== null && typeof pin.projectManifestHash !== 'string' ||
      !Array.isArray(pin.hostReadOnlyRoots) || !pin.hostReadOnlyRoots.every((item): item is string => typeof item === 'string' && path.isAbsolute(item))) throw new RuntimePreparationError('invalid', '固定运行资源回执无效', []);
  if (createHash('sha256').update(JSON.stringify(pin.hostReadOnlyRoots)).digest('hex') !== pin.grantHash) throw new RuntimePreparationError('invalid', '固定运行资源授权摘要不一致', []);
  let declaration: RuntimeDeclarationSource | null = null;
  if (pin.source !== null) {
    if (typeof source.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(source.commit) || typeof source.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.manifestHash) || typeof source.filename !== 'string') throw new RuntimePreparationError('invalid', '固定运行资源声明身份无效', []);
    declaration = { commit: source.commit, manifestHash: source.manifestHash, filename: source.filename, declaration: parseRuntimeDeclaration(source.declaration), ...(source.origin === 'host_registration' && typeof source.registrationHash === 'string' ? { origin: 'host_registration' as const, registrationHash: source.registrationHash } : {}) };
  }
  return { version: 1, executionId: pin.executionId, claimToken: pin.claimToken, sourceRepository: pin.sourceRepository, source: declaration, projectManifestHash: pin.projectManifestHash,
    hostReadOnlyRoots: pin.hostReadOnlyRoots, grantHash: pin.grantHash, identity: pin.identity, receipt: null };
}
const fingerprint = (job: { claimToken: string | null; taskRunId: string | null; dispatchMetadata: unknown }) => {
  const progress = executionProgress(job.dispatchMetadata);
  return { claimToken: job.claimToken, taskRunId: job.taskRunId, revision: progress?.revision, candidateCommit: progress?.candidateCommit,
    phase: progress?.phase, workerNonce: progress?.worker?.nonce, workerReleasedAt: progress?.workerReleasedAt };
};
async function repositoryIdentity(directory: string) {
  const marker = await fs.lstat(path.join(directory, '.git')).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
  if (!marker) return null;
  if (await graphGit(directory, 'rev-parse', '--show-toplevel') !== directory) return null;
  return fs.realpath(await graphGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
}

/** The server ledger and current claim identify runtime inputs even when the stage cwd is not Git. */
export async function prepareTaskDeclaredRuntime(args: Arguments): Promise<PreparedRuntime> {
  const nodeId = args.taskId && /^task-graph-(?:review|architecture)-(.+)$/.exec(args.taskId)?.[1];
  let jobs = nodeId ? await prisma.taskGraphExecution.findMany({ where: { nodeId }, include: { node: true } })
    : args.taskId ? await prisma.taskGraphExecution.findMany({ where: { childTaskId: args.taskId }, include: { node: true } }) : [];
  if (!jobs.length) {
    const grants = resolveLocalRuntimeReadOnlyPaths(args.workspace, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG);
    const result = await prepareDeclaredRuntime({ ...args, approvedReadOnlyRoots: [...args.approvedReadOnlyRoots, ...grants] });
    return { ...result, readOnlyPaths: Array.from(new Set([...result.readOnlyPaths, ...grants])).filter(root => root !== args.workspace) };
  }
  const cwdIdentity = await repositoryIdentity(args.workspace);
  if (nodeId && cwdIdentity) {
    const selected = [];
    for (const job of jobs) if (await repositoryIdentity(await fs.realpath(job.repository)) === cwdIdentity) selected.push(job);
    if (!selected.length) throw new RuntimePreparationError('invalid', '检查目录不属于当前任务图的仓库', [args.workspace]);
    jobs = selected;
  }
  const prepared: PreparedRuntime[] = [];
  for (const job of jobs) {
    const before = fingerprint(job), progress = executionProgress(job.dispatchMetadata);
    if (!job.claimToken || !progress || !['claimed', 'integrated'].includes(job.status) || !['active', 'ready'].includes(progress.state)) throw new RuntimePreparationError('invalid', '当前执行没有可固定运行资源的有效归属', [args.workspace]);
    const repository = await fs.realpath(job.repository), common = await repositoryIdentity(repository);
    if (!common) throw new RuntimePreparationError('invalid', '账本仓库不是有效 Git 根目录', [repository]);
    const expectedCommit = job.status === 'integrated' ? job.commit : progress.candidateCommit;
    const candidates = Array.from(new Set([args.workspace, ...args.approvedReadOnlyRoots]));
    let sourceWorkspace: string | undefined;
    for (const directory of candidates) {
      if (await repositoryIdentity(directory) === common && await graphGit(directory, 'rev-parse', 'HEAD') === expectedCommit) { sourceWorkspace = directory; break; }
    }
    if (!sourceWorkspace) throw new RuntimePreparationError('missing', '本阶段未绑定当前候选的只读源码目录', [args.workspace], expectedCommit || '');
    const key = `runtime-snapshot:${job.id}:${job.claimToken}`;
    const event = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } } });
    const pin = event ? parsePin(record(event.payload).snapshot) : null;
    if (pin && (pin.executionId !== job.id || pin.claimToken !== job.claimToken || pin.sourceRepository !== repository)) throw new RuntimePreparationError('invalid', '固定运行资源归属不一致', [sourceWorkspace]);
    const current = await runtimeDeclaration(sourceWorkspace).catch(error => { throw new RuntimePreparationError('invalid', error instanceof Error ? error.message : String(error), [sourceWorkspace!]); });
    if (current && current.commit !== expectedCommit) throw new RuntimePreparationError('invalid', '运行能力声明的源码提交已改变', [sourceWorkspace]);
    if (pin && (current?.manifestHash || null) !== pin.projectManifestHash) throw new RuntimePreparationError('invalid', '本 claim 的运行能力声明已改变，须经受控新 claim 固定', [sourceWorkspace]);
    const restricted = args.permissionConfig && 'workflowPermissionSnapshot' in args.permissionConfig;
    const hostReadOnlyRoots = pin ? pin.hostReadOnlyRoots : restricted ? resolveLocalRuntimeReadOnlyPaths(repository, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG) : Array.from(new Set([...resolveLocalRuntimeReadOnlyPaths(repository, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG), ...resolveLocalRuntimeReadOnlyPaths(sourceWorkspace, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG)]));
    const registration = !pin && !current && !restricted ? hostRuntimeRegistration(repository) : null;
    let source = pin ? pin.source : current;
    if (!pin && !current && !restricted && registration?.runtime) {
      const text = JSON.stringify(registration.runtime);
      source = { origin: 'host_registration', registrationHash: registration.registrationHash, declaration: registration.runtime, manifestHash: createHash('sha256').update(text).digest('hex'),
        commit: await graphGit(process.cwd(), 'rev-parse', 'HEAD'), filename: registration.configFile || '' };
    }
    const grants = !restricted ? hostReadOnlyRoots : [];
    const result = await prepareDeclaredRuntime({ ...args, sourceDeclaration: source, resourceWorkspace: sourceWorkspace,
      approvedReadOnlyRoots: Array.from(new Set([...args.approvedReadOnlyRoots, ...grants])) });
    if (pin && result.identity !== pin.identity) throw new RuntimePreparationError('invalid', '固定运行资源身份改变', [sourceWorkspace]);
    const snapshot: Pin = pin || { version: 1, executionId: job.id, claimToken: job.claimToken, sourceRepository: repository, source, projectManifestHash: current?.manifestHash || null,
      hostReadOnlyRoots, grantHash: createHash('sha256').update(JSON.stringify(hostReadOnlyRoots)).digest('hex'), identity: result.identity, receipt: result.receipt };
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
      const latest = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      if (!isDeepStrictEqual(fingerprint(latest), before) || latest.status !== job.status) throw new RuntimePreparationError('invalid', '运行资源预检期间归属、候选或 revision 已改变', [sourceWorkspace]);
      if (await fs.realpath(sourceWorkspace) !== sourceWorkspace || await repositoryIdentity(sourceWorkspace) !== common || await graphGit(sourceWorkspace, 'rev-parse', 'HEAD') !== expectedCommit) throw new RuntimePreparationError('invalid', '预检期间固定源码目录或提交改变', [sourceWorkspace]);
      const finalDeclaration = await runtimeDeclaration(sourceWorkspace);
      if ((finalDeclaration?.manifestHash || null) !== (current?.manifestHash || null)) throw new RuntimePreparationError('invalid', '预检期间运行能力声明改变', [sourceWorkspace]);
      const saved = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } } });
      if (saved && !isDeepStrictEqual(parsePin(record(saved.payload).snapshot), parsePin({ ...snapshot }))) throw new RuntimePreparationError('invalid', '固定运行资源回执发生竞争或改变', [sourceWorkspace]);
      if (!saved) await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'runtime_snapshot_pinned', idempotencyKey: key,
        payload: { binding: before, snapshot } } });
    });
    prepared.push({ ...result, readOnlyPaths: Array.from(new Set([...args.approvedReadOnlyRoots, ...grants, ...(result.receipt?.resources.map(resource => resource.path) || [])])).filter(root => root !== args.workspace) });
  }
  const identities = new Set(prepared.map(item => item.identity));
  if (identities.size > 1) throw new RuntimePreparationError('invalid', '多个仓库运行能力不同，须按仓库分别验证，不能隐式合并', [args.workspace]);
  const result = prepared[0];
  return { ...result, readOnlyPaths: Array.from(new Set(prepared.flatMap(item => item.readOnlyPaths))) };
}
