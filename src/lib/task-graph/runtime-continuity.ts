import { approvedRuntimeUpgrade } from './approved-runtime-upgrade';
import { requireGraphNodeActiveTx } from './run-control';
import { projectPythonRuntime } from '../project-capabilities/python-runtime';
import { approvedProjectTools } from '../project-capabilities/tool-runtime';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { platformRepository } from '../platform-repository';
import type { AcpxPermissionConfig } from '../acpx/types';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../acpx/permissions';
import { resolveLocalRuntimeReadOnlyPaths } from '../acpx/runtime-environments';
import { hostRuntimeRegistration } from './runtime-registration';
import { executionProgress } from './execution-progress';
import { graphGit } from './git-command';
import { parseRuntimeDeclaration, runtimeDeclaration, type RuntimeDeclarationSource } from './runtime-contract';
import { prepareDeclaredRuntime, RuntimePreparationError, type PreparedRuntime } from './runtime-preflight';

type Arguments = Parameters<typeof prepareDeclaredRuntime>[0] & { conversationAssociation?: import('./graph-association').GraphAssociation; taskId?: string; permissionConfig?: AcpxPermissionConfig; platformRepository?: string; taskRunId?: string; projectPolicyFile?: string };
type Pin = { version: 1; executionId: string; claimToken: string; sourceRepository: string; source: RuntimeDeclarationSource | null; projectManifestHash: string | null; hostReadOnlyRoots: string[]; grantHash: string; identity: string; receipt: PreparedRuntime['receipt']; authority?: 'project' | 'workflow' | 'legacy'; projectPolicyHash?: string | null; legacyGrantFile?: string; pythonIdentity?: string | null };
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
  if (pin.authority !== undefined && !['project', 'workflow', 'legacy'].includes(String(pin.authority)) || pin.projectPolicyHash !== undefined && pin.projectPolicyHash !== null && (typeof pin.projectPolicyHash !== 'string' || !/^[a-f0-9]{64}$/.test(pin.projectPolicyHash))) throw new RuntimePreparationError('invalid', '固定运行资源授权来源无效', []);
  if (pin.legacyGrantFile !== undefined && (typeof pin.legacyGrantFile !== 'string' || !path.isAbsolute(pin.legacyGrantFile))) throw new RuntimePreparationError('invalid', '固定旧授权来源无效', []);
  if (pin.pythonIdentity !== undefined && pin.pythonIdentity !== null && (typeof pin.pythonIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(pin.pythonIdentity))) throw new RuntimePreparationError('invalid', '固定 Python 身份无效', []);
  return { ...(pin.pythonIdentity !== undefined ? { pythonIdentity: pin.pythonIdentity } : {}), ...(typeof pin.legacyGrantFile === 'string' ? { legacyGrantFile: pin.legacyGrantFile } : {}), ...(pin.authority === 'project' || pin.authority === 'workflow' || pin.authority === 'legacy' ? { authority: pin.authority } : {}), ...(typeof pin.projectPolicyHash === 'string' ? { projectPolicyHash: pin.projectPolicyHash } : {}), version: 1, executionId: pin.executionId, claimToken: pin.claimToken, sourceRepository: pin.sourceRepository, source: declaration, projectManifestHash: pin.projectManifestHash,
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
  if (args.conversationAssociation) {
    const run = args.taskRunId ? await prisma.taskRun.findUnique({ where: { id: args.taskRunId } }) : null;
    const association = record(run?.controlMetadata ? JSON.parse(run.controlMetadata) : {}).graphAssociation;
    if (!run || run.taskId !== args.taskId || !isDeepStrictEqual(association, args.conversationAssociation)) throw new Error('Conversation runtime task identity changed');
    // A human turn has no scheduling claim to pin. Use the ordinary runtime
    // contract with its already authorized roots; never borrow an old claim.
    return prepareDeclaredRuntime({ ...args, strictReadOnlyRoots: true });
  }
  return prepareRuntime(args, false);
}
/** Observe saved execution readiness without issuing a claim or replacing its immutable pin. */
export async function inspectSavedTaskRuntime(args: Arguments): Promise<PreparedRuntime> {
  return prepareRuntime(args, true);
}
async function prepareRuntime(args: Arguments, inspectSaved: boolean): Promise<PreparedRuntime> {
  const platform = args.platformRepository || platformRepository();
  const permissionFile = path.join(platform, 'config/runtime-environments.json');
  const nodeId = args.taskId && /^task-graph-(?:review|architecture)-(.+)$/.exec(args.taskId)?.[1];
  let jobs = nodeId ? await prisma.taskGraphExecution.findMany({ where: { nodeId }, include: { node: true } })
    : args.taskId ? await prisma.taskGraphExecution.findMany({ where: { childTaskId: args.taskId }, include: { node: true } }) : [];
  if (!jobs.length) {
    const grants = resolveLocalRuntimeReadOnlyPaths(args.workspace, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG, permissionFile);
    const tools = await prepareDeclaredRuntime({ ...args, approvedReadOnlyRoots: [...args.approvedReadOnlyRoots, ...grants] });
    return { ...tools, readOnlyPaths: Array.from(new Set([...tools.readOnlyPaths, ...grants])).filter(root => root !== args.workspace) };
  }
  const cwdIdentity = await repositoryIdentity(args.workspace);
  if (nodeId && cwdIdentity) {
    const selected = [];
    for (const job of jobs) if (await repositoryIdentity(await fs.realpath(job.repository)) === cwdIdentity) selected.push(job);
    if (!selected.length) throw new RuntimePreparationError('invalid', '检查目录不属于当前任务图的仓库', [args.workspace]);
    jobs = selected;
  }
  const prepared: (PreparedRuntime & { executionKey: string; repository: string })[] = [];
  for (const job of jobs) {
    const before = fingerprint(job), progress = executionProgress(job.dispatchMetadata);
    const conversation = progress?.conversation?.kind === 'running' && args.permissionConfig?.sandboxMode === 'read-only';
    const savedWait = inspectSaved && ['attention', 'integrated'].includes(job.status) && progress && ['waiting_decision', 'waiting_for_user', 'exhausted'].includes(progress.state) && progress.lastFailure?.code !== 'ownership_mismatch';
    if (!job.claimToken || !progress || !savedWait && !conversation && (!['claimed', 'integrated'].includes(job.status) || !['active', 'ready'].includes(progress.state))) throw new RuntimePreparationError('invalid', '当前执行没有可固定运行资源的有效归属', [args.workspace]);
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
    let pin = event ? parsePin(record(event.payload).snapshot) : null;
    if (pin && (pin.executionId !== job.id || pin.claimToken !== job.claimToken || pin.sourceRepository !== repository)) throw new RuntimePreparationError('invalid', '固定运行资源归属不一致', [sourceWorkspace]);
    const current = await runtimeDeclaration(sourceWorkspace).catch(error => { throw new RuntimePreparationError('invalid', error instanceof Error ? error.message : String(error), [sourceWorkspace!]); });
    if (current && current.commit !== expectedCommit) throw new RuntimePreparationError('invalid', '运行能力声明的源码提交已改变', [sourceWorkspace]);
    if (pin && (current?.manifestHash || null) !== pin.projectManifestHash) throw new RuntimePreparationError('invalid', '本 claim 的运行能力声明已改变，须经受控新 claim 固定', [sourceWorkspace]);
    const restricted = args.permissionConfig && 'workflowPermissionSnapshot' in args.permissionConfig;
    const projectTools = await approvedProjectTools({ taskId: args.taskId!, taskRunId: args.taskRunId, executionId: job.id, repository, sourceWorkspace,
      policyFile: args.projectPolicyFile, permissionConfig: args.permissionConfig, commit: expectedCommit!, declaration: current });
    const approval = projectTools?.approval;
    // Admission may inspect a separately approved replacement, never pin it under the old claim.
    if (inspectSaved && savedWait && approval) {
      const upgrade = await approvedRuntimeUpgrade(job, args.projectPolicyFile);
      if (upgrade?.approvalId === approval.id) pin = null;
    }
    const migratedPin = Boolean(pin && !pin.projectPolicyHash && event && approval?.kind === 'legacy' && approval.runtimePinIds.includes(event.id));
    const changedScope = Boolean(pin && event && approval?.kind === 'change' && approval.runtimePinIds.includes(event.id) &&
      approval.previousPolicyHash === pin.projectPolicyHash && approval.originalClaim === job.claimToken && approval.candidateCommit === expectedCommit);
    if (pin && !migratedPin && !changedScope && (pin.projectPolicyHash || null) !== (projectTools?.policyHash || null)) throw new RuntimePreparationError('invalid', '项目工具授权变化，原运行快照保留；须批准新的执行后重新固定', [repository]);
    if (pin && changedScope && (!isDeepStrictEqual([...pin.hostReadOnlyRoots].sort(), [...(projectTools?.roots || [])].sort()) ||
        !isDeepStrictEqual(pin.source?.declaration || null, projectTools?.declaration?.declaration || null))) throw new RuntimePreparationError('invalid', '资料授权变更不能改变工具声明或挂载', [repository]);
    const grantFile = pin?.legacyGrantFile || permissionFile;
    const currentRoots = projectTools ? projectTools.roots : restricted ? resolveLocalRuntimeReadOnlyPaths(repository, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG, grantFile) : Array.from(new Set([...resolveLocalRuntimeReadOnlyPaths(repository, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG, grantFile), ...resolveLocalRuntimeReadOnlyPaths(sourceWorkspace, args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG, grantFile)]));
    if (pin && !restricted && (pin.authority === 'project' || pin.legacyGrantFile) && pin.authority !== 'workflow' && pin.hostReadOnlyRoots.some(root => !currentRoots.includes(root))) throw new RuntimePreparationError('invalid', '原运行目录授权已撤销，不能复用历史挂载', pin.hostReadOnlyRoots);
    const hostReadOnlyRoots = pin ? pin.hostReadOnlyRoots : currentRoots;
    const registration = !projectTools && !pin && !current && !restricted ? hostRuntimeRegistration(repository, path.join(platform, 'config/runtime-resources.json')) : null;
    let source = pin ? pin.source : projectTools ? projectTools.declaration : current;
    if (!pin && !projectTools && !current && !restricted && registration?.runtime) {
      const text = JSON.stringify(registration.runtime);
      source = { origin: 'host_registration', registrationHash: registration.registrationHash, declaration: registration.runtime, manifestHash: createHash('sha256').update(text).digest('hex'),
        commit: await graphGit(platform, 'rev-parse', 'HEAD'), filename: registration.configFile || '' };
    }
    const python = projectPythonRuntime(sourceWorkspace);
    if (projectTools && python && !projectTools.roots.some(root => python.project.directory === root || python.project.directory.startsWith(root + path.sep))) throw new RuntimePreparationError('invalid', '项目 Python 环境未在批准目录内', [python.project.directory]);
    if (pin?.pythonIdentity !== undefined && pin.pythonIdentity !== (python?.identity || null)) throw new RuntimePreparationError('invalid', '固定 Python 解释器或环境配置已改变', python ? [python.project.directory] : []);
    if (restricted && python && ![args.workspace, ...args.approvedReadOnlyRoots].some(root => python.project.directory === root || python.project.directory.startsWith(root + path.sep))) throw new RuntimePreparationError('invalid', 'Python 环境超出本次显式文件权限', [python.project.directory]);
    const grants = !restricted ? [...hostReadOnlyRoots, ...(python ? [python.project.directory] : [])] : [];
    const tools = await prepareDeclaredRuntime({ ...args, sourceDeclaration: source, resourceWorkspace: sourceWorkspace, strictReadOnlyRoots: Boolean(projectTools),
      probeScope: { runId: job.node.runId, nodeId: job.nodeId, repository, pythonIdentity: python?.identity || null,
        policy: createHash('sha256').update(JSON.stringify({ authority: projectTools ? 'project' : restricted ? 'workflow' : 'legacy', policy: projectTools?.policyHash || null, roots: [...hostReadOnlyRoots].sort() })).digest('hex'),
        sourceIdentity: source?.origin === 'host_registration' ? null : source?.commit || null },
      approvedReadOnlyRoots: Array.from(new Set([...args.approvedReadOnlyRoots, ...grants])) });
    const pinPython = !pin || pin.pythonIdentity !== undefined;
    const pythonIdentity = python && pinPython ? createHash('sha256').update(JSON.stringify([tools.identity, python.identity])).digest('hex') : tools.identity;
    const result = { ...tools, identity: pythonIdentity, env: { ...tools.env, ...(pinPython ? { AP_PROJECT_PYTHON_ENVIRONMENTS_JSON: JSON.stringify(python ? [{ repository, directory: python.project.directory }] : []) } : {}),
      ...(python && pinPython ? { ...python.project.env, AP_GRAPH_RUNTIME_IDENTITY: pythonIdentity } : {}) } };
    if (pin && result.identity !== pin.identity) throw new RuntimePreparationError('invalid', '固定运行资源身份改变', [sourceWorkspace]);
    const snapshot: Pin = pin || { pythonIdentity: python?.identity || null, authority: projectTools ? 'project' : restricted ? 'workflow' : 'legacy', ...(!projectTools && !restricted ? { legacyGrantFile: permissionFile } : {}), ...(projectTools ? { projectPolicyHash: projectTools.policyHash } : {}), version: 1, executionId: job.id, claimToken: job.claimToken, sourceRepository: repository, source, projectManifestHash: current?.manifestHash || null,
      hostReadOnlyRoots, grantHash: createHash('sha256').update(JSON.stringify(hostReadOnlyRoots)).digest('hex'), identity: result.identity, receipt: result.receipt };
    if (await fs.realpath(sourceWorkspace) !== sourceWorkspace || await repositoryIdentity(sourceWorkspace) !== common || await graphGit(sourceWorkspace, 'rev-parse', 'HEAD') !== expectedCommit) throw new RuntimePreparationError('invalid', '预检期间固定源码目录或提交改变', [sourceWorkspace]);
    const latestTools = await approvedProjectTools({ taskId: args.taskId!, taskRunId: args.taskRunId, executionId: job.id, repository, sourceWorkspace,
      policyFile: args.projectPolicyFile, permissionConfig: args.permissionConfig, commit: expectedCommit!, declaration: current });
    if ((latestTools?.policyHash || null) !== (projectTools?.policyHash || null) || !isDeepStrictEqual(latestTools?.approval, projectTools?.approval)) throw new RuntimePreparationError('invalid', '预检期间项目授权改变', [repository]);
    if ((projectPythonRuntime(sourceWorkspace)?.identity || null) !== (python?.identity || null)) throw new RuntimePreparationError('invalid', '预检期间 Python 环境改变', [sourceWorkspace]);
    const finalDeclaration = await runtimeDeclaration(sourceWorkspace);
    if ((finalDeclaration?.manifestHash || null) !== (current?.manifestHash || null)) throw new RuntimePreparationError('invalid', '预检期间运行能力声明改变', [sourceWorkspace]);
    if (!inspectSaved) await prisma.$transaction(async tx => {
      await requireGraphNodeActiveTx(tx, job.nodeId);
      await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${job.nodeId} FOR UPDATE`;
      const latest = await tx.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      if (!isDeepStrictEqual(fingerprint(latest), before) || latest.status !== job.status) throw new RuntimePreparationError('invalid', '运行资源预检期间归属、候选或 revision 已改变', [sourceWorkspace]);
      const ledgerTools = await approvedProjectTools({ taskId: args.taskId!, taskRunId: args.taskRunId, executionId: job.id, repository, sourceWorkspace,
        policyFile: args.projectPolicyFile, permissionConfig: args.permissionConfig, commit: expectedCommit!, declaration: current },
        { db: tx, registeredPolicy: latestTools?.registeredPolicy || null });
      if (!isDeepStrictEqual(ledgerTools, latestTools)) throw new RuntimePreparationError('invalid', '预检期间项目授权或批准身份改变', [repository]);
      const saved = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } } });
      if (saved && !isDeepStrictEqual(parsePin(record(saved.payload).snapshot), parsePin({ ...snapshot }))) throw new RuntimePreparationError('invalid', '固定运行资源回执发生竞争或改变', [sourceWorkspace]);
      if (!saved) await tx.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'runtime_snapshot_pinned', idempotencyKey: key,
        payload: { binding: before, snapshot } } });
      if (changedScope && approval?.kind === 'change' && event) await tx.taskGraphEvent.upsert({
        where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: `runtime-authorization:${job.id}:${job.claimToken}:${progress.revision}:${args.taskRunId || 'preflight'}:${approval.id}` } },
        update: {}, create: { runId: job.node.runId, nodeId: job.nodeId, kind: 'runtime_authorization_bound',
          idempotencyKey: `runtime-authorization:${job.id}:${job.claimToken}:${progress.revision}:${args.taskRunId || 'preflight'}:${approval.id}`,
          payload: { executionId: job.id, originalPinId: event.id, approvalId: approval.id, taskRunId: args.taskRunId || null,
            stage: progress.phase, candidateCommit: expectedCommit, claimToken: job.claimToken, revision: progress.revision,
            policyHash: projectTools?.policyHash, runtimeIdentity: result.identity } } });
    });
    prepared.push({ ...result, executionKey: job.key, repository, readOnlyPaths: Array.from(new Set([...args.approvedReadOnlyRoots, ...grants, ...(python ? [python.project.directory] : []), ...(result.receipt?.resources.map(resource => resource.path) || [])])).filter(root => root !== args.workspace) });
  }
  const identities = new Set(prepared.map(item => item.identity));
  if (identities.size > 1) {
    const tools = prepared.map(item => ({ key: item.executionKey, repository: item.repository, identity: item.identity, env: item.env }));
    const identity = createHash('sha256').update(JSON.stringify(tools.map(({ key, repository, identity }) => ({ key, repository, identity })))).digest('hex');
    return { identity, manifestHash: identity, receipt: null, env: { AP_GRAPH_RUNTIME_IDENTITY: identity, AP_PROJECT_TOOL_RUNTIMES_JSON: JSON.stringify(tools), AP_PROJECT_PYTHON_ENVIRONMENTS_JSON: JSON.stringify(prepared.flatMap(item => JSON.parse(item.env.AP_PROJECT_PYTHON_ENVIRONMENTS_JSON || '[]'))) },
      readOnlyPaths: Array.from(new Set(prepared.flatMap(item => item.readOnlyPaths))), verifiedResources: prepared.flatMap(item => item.verifiedResources),
      instructions: '\n本阶段含不同项目工具。按 AP_PROJECT_TOOL_RUNTIMES_JSON 的仓内任务键选择对应 env 启动检查命令，没有全局默认工具。' + prepared.map(item => `\n仓内任务 ${item.executionKey}：${item.instructions}`).join('') };
  }
  const result = prepared[0];
  return { ...result, env: { ...result.env, ...(prepared.every(item => item.env.AP_PROJECT_PYTHON_ENVIRONMENTS_JSON) ? { AP_PROJECT_PYTHON_ENVIRONMENTS_JSON: JSON.stringify(prepared.flatMap(item => JSON.parse(item.env.AP_PROJECT_PYTHON_ENVIRONMENTS_JSON))) } : {}) }, readOnlyPaths: Array.from(new Set(prepared.flatMap(item => item.readOnlyPaths))) };
}
