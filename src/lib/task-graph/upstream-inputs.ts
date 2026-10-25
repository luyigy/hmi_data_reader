import { executionProgress } from './execution-progress';
import { prepareExtraRepositories } from './extra-repositories';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../prisma';
import { projectEnvironment } from '../harness/project-environment';
import { graphDependencyPaths } from './dependency-paths';
import { graphGit } from './git-command';
import { withRepositoryLock } from './repository-lock';
import { materializeUpstream } from './upstream-source';
import { selfCheckExecution, verificationInputs, isCompletedNodeStatus, type GraphDefinition } from './domain';
import { isRecord } from './implementation-result';

type Input = { repository: string; commit: string; sourcePath: string; executions: string[]; resultsDirectories: string[];
  projectEnvPath: string | null; pythonExecutable: string | null; dependencyPaths: string[]; quality: string[] };
export type TaskInputManifest = { version: 1; executionId: string; primaryRepository: string; inputs: Input[]; ticketInputs?: { executionId: string; commit: string | null }[]; hash: string };
export type PreparedInputs = { manifest: TaskInputManifest; readOnlyPaths: string[]; env: Record<string, string>; instructions: string };

function closure(graph: GraphDefinition, key: string) {
  const result = new Set<string>();
  function visit(nodeKey: string) {
    const node = graph.nodes.find(item => item.key === nodeKey);
    if (!node) throw new Error('批准图缺少前置节点');
    for (const predecessor of node.dependsOn) if (!result.has(predecessor)) { result.add(predecessor); visit(predecessor); }
  }
  visit(key); return result;
}

async function hydrate(manifest: TaskInputManifest): Promise<PreparedInputs> {
  const readOnlyPaths: string[] = [];
  for (const input of manifest.inputs) {
    const directory = await withRepositoryLock(input.repository, () => materializeUpstream(input.repository, input.commit));
    if (directory !== input.sourcePath) throw new Error('上游固定源码目录配置改变，不能静默换输入');
    const project = projectEnvironment(input.repository);
    if ((project?.directory || null) !== input.projectEnvPath) throw new Error('前置项目环境配置已改变，需要新尝试核对');
    for (const entry of [...input.resultsDirectories, ...input.dependencyPaths]) if (!existsSync(entry)) throw new Error(`前置报告或依赖不可用：${entry}`);
    readOnlyPaths.push(directory, ...input.resultsDirectories, ...input.dependencyPaths, ...(input.projectEnvPath ? [input.projectEnvPath] : []));
  }
  return { manifest, readOnlyPaths: Array.from(new Set(readOnlyPaths)),
    env: { TASK_GRAPH_UPSTREAM_INPUTS_JSON: JSON.stringify([manifest]), AP_PROJECT_REPOSITORY: manifest.primaryRepository },
    instructions: `\n本轮固定输入清单 ${manifest.hash}：${JSON.stringify(manifest)}\n清单含已完成前置及整票责任人本轮可用的同票集成源码；同票 integrated 不表示验收通过。输入源码和环境只读；跨仓调用使用对应 sourcePath 和 pythonExecutable。默认环境只归主仓，不能拼接多仓 PYTHONPATH。源码副本无 .git，Git 历史操作走平台。归档仅列已绑定交付版本的路径，缺少路径不等于从未验证；不能把旧报告冒充当前版本证据。输入不可用报告平台输入/环境阻塞，不要求用户重复发图。` };
}

/** Resolve approved dependency relations once per execution claim, then replay the same recorded input. */
async function resolveUpstreamInputs(executionId: string): Promise<PreparedInputs> {
  const execution = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId }, include: { node: { include: { run: true } } } });
  const { node } = execution;
  const graph = node.run.snapshot as unknown as GraphDefinition;
  const planned = graph.nodes.find(item => item.key === node.key);
  if (!planned) throw new Error('任务不属于批准图');
  await prepareExtraRepositories(planned.extraRepositories);
  const eventKey = `execution:${execution.id}:inputs:${execution.claimToken || 'legacy'}`;
  const existing = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: eventKey } } });
  if (existing) return hydrate(parseManifest(existing.payload));
  const required = closure(graph, node.key);
  const canonical = (repository: string) => realpath(repository).catch(() => repository);
  const primaryRepository = await canonical(execution.repository);
  const rows = await prisma.taskGraphNode.findMany({ where: { runId: node.runId }, include: { executions: true } });
  const all = await Promise.all(rows.map(async item => ({ ...item, executions: await Promise.all(item.executions.map(async job => ({ ...job, repository: await canonical(job.repository) }))) })));
  for (const ancestor of all.filter(item => required.has(item.key))) {
    if (!isCompletedNodeStatus(ancestor.status) || ancestor.executions.some(job => job.status !== 'integrated' || !job.commit)) throw new Error(`前置 ${ancestor.key} 未达到批准完成条件`);
    if (ancestor.status === 'delivered_unverified' && graph.nodes.find(item => item.key === ancestor.key)?.executionMode !== 'implement') throw new Error('前置未验收状态不符合批准模式');
  }
  const siblings = all.find(item => item.id === node.id)!.executions.filter(job => job.id !== executionId);
  const ticketInputs = graph.deliveryContract === 'agent_owned_v1' && selfCheckExecution(planned) === execution.key &&
    siblings.every(job => job.status === 'integrated' && job.commit) ? verificationInputs(siblings) : undefined;
  const candidates = all.filter(item => required.has(item.key)).flatMap(item => item.executions.map(job => ({ ...job, nodeKey: item.key, quality: item.status }))).concat(ticketInputs ? siblings.map(job => ({ ...job, nodeKey: node.key, quality: 'integrated' })) : []);
  const policy = planned.consumeUpstream || 'direct';
  const selected = candidates.filter(job => job.nodeKey === node.key || (policy !== 'none' && (Array.isArray(policy) ? policy.includes(`${job.nodeKey}/${job.key}`) : planned.dependsOn.includes(job.nodeKey))));
  const repositories = Array.from(new Set(selected.map(job => job.repository).filter(repo => repo !== primaryRepository))).sort();
  const inputs: Input[] = [];
  for (const repository of repositories) {
    const jobs = candidates.filter(job => job.repository === repository);
    let commit: string | undefined;
    for (const job of jobs) {
      if (!job.commit) throw new Error('前置提交缺失');
      let covers = true;
      for (const other of jobs) if (!other.commit || !await graphGit(repository, 'merge-base', '--is-ancestor', other.commit, job.commit).then(() => true, () => false)) covers = false;
      if (covers) commit = job.commit;
    }
    if (!commit) throw new Error('前置提交没有已完成的汇合版本，不能自行合并');
    const integratedHistory = await prisma.taskGraphEvent.findMany({ where: { runId: node.runId, kind: 'execution_integrated' }, select: { nodeId: true, payload: true } });
    for (const sibling of all.filter(item => !required.has(item.key) && !(ticketInputs && item.id === node.id) && !isCompletedNodeStatus(item.status))) {
      if (!sibling.executions.some(job => job.repository === repository)) continue;
      for (const receipt of integratedHistory.filter(event => event.nodeId === sibling.id)) {
        if (isRecord(receipt.payload) && typeof receipt.payload.commit === 'string' &&
          await graphGit(repository, 'merge-base', '--is-ancestor', receipt.payload.commit, commit).then(() => true, () => false)) throw new Error(`候选夹带未通过节点 ${sibling.key} 的历史交付`);
      }
      for (const job of sibling.executions.filter(job => job.repository === repository && job.commit)) {
        if (await graphGit(repository, 'merge-base', '--is-ancestor', job.commit!, commit).then(() => true, () => false)) throw new Error(`候选夹带未通过节点 ${sibling.key}，停止输入准备`);
      }
    }
    const receipts = await prisma.taskGraphEvent.findMany({ where: { runId: node.runId, nodeId: { in: all.filter(item => required.has(item.key)).map(item => item.id) }, kind: { in: ['workspace_cleaned', 'validation_workspace_cleaned'] } } });
    const results = receipts.flatMap(event => {
      const payload = event.payload;
      if (!isRecord(payload)) return [];
      if (event.kind === 'workspace_cleaned' && jobs.some(job => job.id === payload.executionId && job.commit === payload.commit) && typeof payload.resultsDirectory === 'string') return [payload.resultsDirectory];
      if (event.kind === 'validation_workspace_cleaned' && Array.isArray(payload.deliveryCommits) && payload.deliveryCommits.some(item => isRecord(item) && jobs.some(job => job.id === item.executionId && job.commit === item.commit)) && typeof payload.directory === 'string' && existsSync(payload.directory)) return [payload.directory];
      return [];
    });
    const project = projectEnvironment(repository);
    const sourcePath = await withRepositoryLock(repository, () => materializeUpstream(repository, commit!));
    inputs.push({ repository, commit, sourcePath, executions: jobs.map(job => `${job.nodeKey}/${job.key}`), resultsDirectories: Array.from(new Set(results)),
      projectEnvPath: project?.directory || null, pythonExecutable: project ? path.join(project.directory, 'bin', 'python') : null,
      dependencyPaths: graphDependencyPaths(repository), quality: jobs.map(job => job.quality) });
  }
  const content = { version: 1 as const, executionId, primaryRepository, inputs, ...(ticketInputs ? { ticketInputs } : {}) };
  const manifest: TaskInputManifest = { ...content, hash: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
  const event = await prisma.$transaction(async tx => {
    const previous = await tx.taskGraphEvent.findFirst({ where: { nodeId: node.id, kind: 'task_inputs_prepared', idempotencyKey: { not: eventKey },
      payload: { path: ['executionId'], equals: executionId } }, orderBy: { createdAt: 'desc' } });
    const recorded = await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: node.runId, idempotencyKey: eventKey } },
      create: { runId: node.runId, nodeId: node.id, idempotencyKey: eventKey, kind: 'task_inputs_prepared', payload: JSON.parse(JSON.stringify(manifest)) }, update: {} });
    if (isRecord(previous?.payload) && previous.payload.hash !== manifest.hash) await tx.taskGraphEvent.createMany({ data: [{
      runId: node.runId, nodeId: node.id, idempotencyKey: eventKey + ':changed', kind: 'task_inputs_changed',
      payload: { executionId, previousHash: String(previous.payload.hash), currentHash: manifest.hash } }], skipDuplicates: true });
    return recorded;
  });
  return hydrate(parseManifest(event.payload));
}

function parseManifest(value: unknown): TaskInputManifest {
  // Payloads originate only in this module; compare the immutable digest before using any stored paths.
  if (!isRecord(value) || value.version !== 1 || typeof value.executionId !== 'string' || typeof value.primaryRepository !== 'string' ||
      !Array.isArray(value.inputs) || typeof value.hash !== 'string') throw new Error('固定输入清单无效');
  const inputs: Input[] = value.inputs.map(input => {
    if (!isRecord(input) || typeof input.repository !== 'string' || typeof input.commit !== 'string' || typeof input.sourcePath !== 'string' ||
      !Array.isArray(input.executions) || !input.executions.every(x => typeof x === 'string') || !Array.isArray(input.resultsDirectories) || !input.resultsDirectories.every(x => typeof x === 'string') ||
      !Array.isArray(input.dependencyPaths) || !input.dependencyPaths.every(x => typeof x === 'string') || !Array.isArray(input.quality) || !input.quality.every(x => typeof x === 'string') ||
      !(input.projectEnvPath === null || typeof input.projectEnvPath === 'string') || !(input.pythonExecutable === null || typeof input.pythonExecutable === 'string')) throw new Error('固定输入条目无效');
    return { repository: input.repository, commit: input.commit, sourcePath: input.sourcePath, executions: input.executions, resultsDirectories: input.resultsDirectories,
      projectEnvPath: input.projectEnvPath, pythonExecutable: input.pythonExecutable, dependencyPaths: input.dependencyPaths, quality: input.quality };
  });
  const manifest: TaskInputManifest = { version: 1, executionId: value.executionId, primaryRepository: value.primaryRepository, inputs, ...(Array.isArray(value.ticketInputs) ? { ticketInputs: value.ticketInputs.map(item => { if (!isRecord(item) || typeof item.executionId !== 'string' || typeof item.commit !== 'string') throw new Error('整票输入提交无效'); return { executionId: item.executionId, commit: item.commit }; }) } : {}), hash: value.hash };
  const { hash, ...content } = manifest;
  if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== hash) throw new Error('固定输入清单摘要不一致');
  return manifest;
}

/** Readonly QA and all native roles receive the same claim-pinned manifests. */
export async function graphInputsForTask(taskId: string, forceReadOnly = false): Promise<{ paths: string[]; writablePaths: string[]; instructions: string; env: Record<string, string>; manifests: TaskInputManifest[] }> {
  const jobId = /^task-graph-discussion-(.+)$/.exec(taskId)?.[1];
  const nodeId = /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId)?.[1];
  const jobs = await prisma.taskGraphExecution.findMany({ where: jobId ? { id: jobId } : nodeId ? { nodeId } : { childTaskId: taskId }, orderBy: { key: 'asc' } });
  const prepared = await Promise.all(jobs.map(job => prepareUpstreamInputs(job.id)));
  const nodeIds = Array.from(new Set(jobs.map(job => job.nodeId)));
  const nodes = await prisma.taskGraphNode.findMany({ where: { id: { in: nodeIds } }, include: { run: true } });
  const declarations = nodes.flatMap(node => (node.run.snapshot as unknown as GraphDefinition).nodes.find(planned => planned.key === node.key)?.extraRepositories || []);
  const merged = new Map<string, (typeof declarations)[number]>();
  for (const declaration of declarations) if (merged.get(declaration.repository)?.access !== 'write') merged.set(declaration.repository, declaration);
  const conflictRepair = jobs.some(job => executionProgress(job.dispatchMetadata)?.conflictRepair);
  const extra = await prepareExtraRepositories(Array.from(merged.values()), forceReadOnly || !!nodeId || !!jobId || conflictRepair);
  const archives = await prisma.taskGraphEvent.findMany({ where: { nodeId: { in: jobs.map(job => job.nodeId) }, kind: 'workspace_cleaned' }, select: { payload: true } });
  const reportPaths = archives.flatMap(event => {
    const payload = event.payload;
    return isRecord(payload) && jobs.some(job => job.id === payload.executionId && job.commit === payload.commit) && typeof payload.resultsDirectory === 'string' && existsSync(payload.resultsDirectory) ? [payload.resultsDirectory] : [];
  });
  return { manifests: prepared.map(item => item.manifest), paths: Array.from(new Set([...prepared.flatMap(item => item.readOnlyPaths), ...reportPaths, ...extra.paths])), writablePaths: extra.writablePaths, instructions: prepared.map(item => item.instructions).join('\n') + extra.instructions,
    env: prepared.length ? { ...extra.env, TASK_GRAPH_UPSTREAM_INPUTS_JSON: JSON.stringify(prepared.map(item => item.manifest)), AP_PROJECT_REPOSITORY: jobs.at(-1)!.repository } : {} };
}

export class TaskInputPreparationError extends Error {
  constructor(cause: unknown, public readonly blockerKind: 'missing_upstream_input' | 'environment_failed' = 'missing_upstream_input', public readonly blockedPhase: 'input_preparation' | 'service_runtime' = 'input_preparation') { super(`固定输入准备失败：${cause instanceof Error ? cause.message : String(cause)}`); this.name = 'TaskInputPreparationError'; Object.setPrototypeOf(this, new.target.prototype); }
}
export async function prepareUpstreamInputs(executionId: string): Promise<PreparedInputs> {
  try { return await resolveUpstreamInputs(executionId); }
  catch (error) { throw new TaskInputPreparationError(error); }
}
