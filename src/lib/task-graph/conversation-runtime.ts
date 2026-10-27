import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '../prisma';
import { platformRepository } from '../platform-repository';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../acpx/permissions';
import { resolveLocalRuntimeReadOnlyPaths } from '../acpx/runtime-environments';
import { approvedProjectTools } from '../project-capabilities/tool-runtime';
import { projectPythonRuntime } from '../project-capabilities/python-runtime';
import { graphResourceJobs, type GraphAssociation } from './graph-association';
import { graphGit } from './git-command';
import { runtimeDeclaration } from './runtime-contract';
import { hostRuntimeRegistration } from './runtime-registration';
import { prepareDeclaredRuntime, type PreparedRuntime } from './runtime-preflight';

type Arguments = Parameters<typeof prepareDeclaredRuntime>[0] & {
  conversationAssociation: GraphAssociation; taskId?: string; taskRunId?: string;
  permissionConfig?: import('../acpx/types').AcpxPermissionConfig; platformRepository?: string; projectPolicyFile?: string;
};
const contains = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const commonGit = (directory: string) => graphGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir').then(realpath).catch(() => null);

/** Human runs resolve current grants and record actual source versions without borrowing a scheduler claim. */
export async function prepareConversationRuntime(args: Arguments): Promise<PreparedRuntime> {
  const run = args.taskRunId ? await prisma.taskRun.findUnique({ where: { id: args.taskRunId } }) : null;
  const metadata = JSON.parse(run?.controlMetadata || '{}');
  if (!run || run.taskId !== args.taskId || !isDeepStrictEqual(metadata.graphAssociation, args.conversationAssociation)) throw new Error('Conversation runtime task identity changed');
  const jobs = await graphResourceJobs(run.taskId);
  if (!jobs.length || !isDeepStrictEqual(jobs.map(job => job.id).sort(), [...args.conversationAssociation.executionIds].sort())) throw new Error('Conversation resource ownership changed');
  const permission = args.permissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG;
  const platform = args.platformRepository || platformRepository();
  const restricted = 'workflowPermissionSnapshot' in permission;
  const prepared: Array<PreparedRuntime & { key: string; repository: string; sourceWorkspace: string; commit: string }> = [];
  for (const job of jobs) {
    const repository = await realpath(job.repository);
    const common = await commonGit(repository);
    if (!common) throw new Error('Conversation repository is not a Git root');
    const candidates = Array.from(new Set([args.workspace, ...permission.writableRoots, ...args.approvedReadOnlyRoots]));
    let sourceWorkspace: string | undefined;
    for (const candidate of candidates) {
      if (await commonGit(candidate) === common) { sourceWorkspace = await realpath(candidate); break; }
    }
    if (!sourceWorkspace) throw new Error(`Conversation source directory is not authorized: ${repository}`);
    const commit = await graphGit(sourceWorkspace, 'rev-parse', 'HEAD');
    const current = await runtimeDeclaration(sourceWorkspace);
    const tools = await approvedProjectTools({ taskId: run.taskId, taskRunId: run.id, executionId: job.id, repository,
      sourceWorkspace, policyFile: args.projectPolicyFile, permissionConfig: permission, commit, declaration: current });
    const grantFile = path.join(platform, 'config/runtime-environments.json');
    const roots = tools?.roots || Array.from(new Set([repository, sourceWorkspace].flatMap(directory => resolveLocalRuntimeReadOnlyPaths(directory, permission, grantFile))));
    const registration = !tools && !current && !restricted ? hostRuntimeRegistration(repository, path.join(platform, 'config/runtime-resources.json')) : null;
    const source = tools ? tools.declaration : current || (registration?.runtime ? {
      origin: 'host_registration' as const, registrationHash: registration.registrationHash, declaration: registration.runtime,
      manifestHash: createHash('sha256').update(JSON.stringify(registration.runtime)).digest('hex'), commit,
      filename: registration.configFile || '',
    } : null);
    const python = projectPythonRuntime(sourceWorkspace);
    if (python && tools && !roots.some(root => contains(root, python.project.directory))) throw new Error('Project Python environment is not authorized');
    if (python && restricted && ![args.workspace, ...args.approvedReadOnlyRoots].some(root => contains(root, python.project.directory))) throw new Error('Python environment exceeds explicit file permissions');
    const grants = [...roots, ...(python ? [python.project.directory] : [])];
    const result = await prepareDeclaredRuntime({ ...args, sourceDeclaration: source, resourceWorkspace: sourceWorkspace,
      strictReadOnlyRoots: true, approvedReadOnlyRoots: Array.from(new Set([...args.approvedReadOnlyRoots, ...grants])) });
    const latest = await approvedProjectTools({ taskId: run.taskId, taskRunId: run.id, executionId: job.id, repository,
      sourceWorkspace, policyFile: args.projectPolicyFile, permissionConfig: permission, commit, declaration: current });
    if (!isDeepStrictEqual(latest, tools) || await graphGit(sourceWorkspace, 'rev-parse', 'HEAD') !== commit ||
      (await runtimeDeclaration(sourceWorkspace))?.manifestHash !== current?.manifestHash ||
      (projectPythonRuntime(sourceWorkspace)?.identity || null) !== (python?.identity || null)) throw new Error('Conversation runtime changed during preparation');
    const identity = createHash('sha256').update(JSON.stringify({ runtime: result.identity, python: python?.identity || null, commit })).digest('hex');
    prepared.push({ ...result, identity, key: job.key, repository, sourceWorkspace, commit,
      env: { ...result.env, ...python?.project.env, AP_GRAPH_RUNTIME_IDENTITY: identity,
        AP_PROJECT_PYTHON_ENVIRONMENTS_JSON: JSON.stringify(python ? [{ repository, directory: python.project.directory }] : []) },
      readOnlyPaths: Array.from(new Set([...result.readOnlyPaths, ...grants])).filter(root => root !== args.workspace) });
  }
  // This receipt describes what was run. S03 result publication must bind evidence to these versions.
  await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: args.conversationAssociation.runId, idempotencyKey: `room-runtime:${run.id}` } },
    update: {}, create: { runId: args.conversationAssociation.runId, nodeId: args.conversationAssociation.nodeId,
      kind: 'room_runtime_prepared', idempotencyKey: `room-runtime:${run.id}`, payload: { taskRunId: run.id,
        sources: prepared.map(item => ({ key: item.key, repository: item.repository, directory: item.sourceWorkspace, commit: item.commit, identity: item.identity })) } } });
  const identity = prepared.length === 1 ? prepared[0].identity : createHash('sha256').update(JSON.stringify(prepared.map(item => item.identity))).digest('hex');
  return { identity, manifestHash: prepared[0].manifestHash, receipt: prepared.length === 1 ? prepared[0].receipt : null,
    verifiedResources: prepared.flatMap(item => item.verifiedResources), readOnlyPaths: Array.from(new Set(prepared.flatMap(item => item.readOnlyPaths))),
    instructions: prepared.map(item => `\n项目 ${item.key} 实际源码 ${item.commit} (${item.sourceWorkspace})：${item.instructions}`).join(''),
    env: { ...(prepared.length === 1 ? prepared[0].env : { AP_PROJECT_TOOL_RUNTIMES_JSON: JSON.stringify(prepared.map(({ key, repository, identity, env }) => ({ key, repository, identity, env }))) }),
      AP_GRAPH_RUNTIME_IDENTITY: identity, AP_PROJECT_PYTHON_ENVIRONMENTS_JSON: JSON.stringify(prepared.flatMap(item => JSON.parse(item.env.AP_PROJECT_PYTHON_ENVIRONMENTS_JSON))) } };
}
