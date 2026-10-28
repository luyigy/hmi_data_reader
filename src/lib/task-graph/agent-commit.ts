import { isDeepStrictEqual } from 'node:util';
import type { GraphDefinition } from './domain';
import { createHash } from 'node:crypto';
import { mkdir, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, TaskGraphExecution } from '@prisma/client';
import { prisma } from '../prisma';
import { graphGit } from './git-command';
import { inspectJobWorktree, TaskGraphGitError } from './worktree';
import { completedRoomSource } from './result-source';
import { observeTaskRunWriter } from './writer-ownership';
import { executionProgress } from './execution-progress';
import { isRecord, parseImplementationResult } from './implementation-result';
import type { ResultBinding } from './task-run-result';

/** Grant only objects, this worktree's index/HEAD, and its private ref namespace. */
export async function agentCommitGitAccess(taskId: string, workspace?: string) {
  const job = await prisma.taskGraphExecution.findFirst({ where: { childTaskId: taskId }, include: { node: { include: { run: true } } } });
  if (!job || !isRecord(job.node.run.snapshot) || job.node.run.snapshot.deliveryContract !== 'agent_commit_v1') return null;
  if (!workspace || workspace !== job.worktreePath) throw new Error('Agent commit workspace differs from the execution ledger');
  const inspected = await inspectJobWorktree({ repoPath: job.repository, runId: job.node.runId, jobId: job.id,
    baseCommit: executionProgress(job.dispatchMetadata)?.workspaceBase || job.baseCommit, worktreePath: workspace });
  if (inspected.branch !== job.worktreeBranch || !inspected.branch.endsWith('/head')) throw new Error('Agent commit requires its own ref namespace');
  const common = await graphGit(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const directory = await graphGit(workspace, 'rev-parse', '--absolute-git-dir');
  const roots = [path.join(common, 'objects'), directory, path.join(common, path.dirname(inspected.branch)), path.join(common, 'logs', path.dirname(inspected.branch))];
  for (const root of roots) {
    let ancestor = root;
    while (!await realpath(ancestor).then(() => true, () => false)) ancestor = path.dirname(ancestor);
    if (await realpath(ancestor) !== ancestor) throw new Error('Agent Git writable path contains a symlink');
    await mkdir(root, { recursive: true });
    if (await realpath(root) !== root) throw new Error('Agent Git writable path contains a symlink');
  }
  const readonly: string[] = [];
  const split = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Agent Git metadata must not contain symlinks');
      if (roots.includes(child)) continue;
      if (roots.some(root => root.startsWith(child + path.sep))) {
        if (!entry.isDirectory()) throw new Error('Git metadata directory is not canonical');
        await split(child);
      } else readonly.push(child);
    }
  };
  await split(common);
  return { writable: roots, readonly };
}

/** Formal source validation; no add, commit, merge or business commands. */
export async function validateAgentCommit(tx: Prisma.TransactionClient, job: TaskGraphExecution, taskRunId: string, commit: unknown) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('agent_commit_v1 delivered requires a full commit SHA');
  const node = await tx.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId }, include: { run: true } });
  const definition = node.run.snapshot as unknown as GraphDefinition;
  const planned = definition.nodes.find(item => item.key === node.key);
  const approved = planned?.executions.find(item => item.key === job.key);
  if (definition.deliveryContract !== 'agent_commit_v1' || planned?.executions.length !== 1 || !approved ||
      approved.repository !== job.repository || approved.gitRef !== job.gitRef || approved.baseCommit !== job.baseCommit ||
      approved.agentSelector !== job.agentSelector || !isDeepStrictEqual(approved.launchConfig, job.launchConfig)) throw new Error('Execution differs from the approved repository, baseline or actor');
  const turn = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, include: { participants: true } });
  const result = parseImplementationResult(turn.participants[0]?.summary || turn.summary || '');
  if (result.status !== 'delivered' || result.commit !== commit) throw new Error('TaskRun did not report this commit as delivered');
  const metadata = JSON.parse(turn.controlMetadata || '{}');
  const binding = metadata.graphResultBinding as ResultBinding | undefined;
  if (!binding?.authorized || binding.deliveryContract !== 'agent_commit_v1' || binding.taskRunId !== taskRunId ||
      binding.taskId !== job.childTaskId || turn.taskId !== job.childTaskId || binding.nodeId !== node.id || binding.runId !== node.runId ||
      binding.executionIds.length !== 1 || binding.executionIds[0] !== job.id ||
      binding.snapshotHash !== createHash('sha256').update(JSON.stringify(node.run.snapshot)).digest('hex') ||
      turn.participants.length !== 1 || turn.participants[0].status !== 'completed') throw new Error('Agent commit TaskRun identity does not match the approved execution');
  if ((await observeTaskRunWriter(taskRunId, tx)).kind !== 'exited') throw new Error('Agent commit writer has not demonstrably exited');
  const completion = await completedRoomSource(tx, taskRunId);
  const source = completion.sources[0];
  if (completion.sources.length !== 1 || source.executionId !== job.id || source.directory !== job.worktreePath || source.commit !== commit) throw new Error('Reported commit differs from the TaskRun final source');
  const progress = executionProgress(job.dispatchMetadata);
  const workspace = await inspectJobWorktree({ repoPath: job.repository, runId: node.runId, jobId: job.id,
    worktreePath: job.worktreePath!, baseCommit: progress?.workspaceBase || job.baseCommit,
    ...(progress?.candidateCommit ? { resumeCommit: progress.candidateCommit } : {}) });
  if (workspace.branch !== job.worktreeBranch || workspace.head !== commit ||
      await graphGit(workspace.path, 'rev-parse', 'HEAD^{tree}') !== source.tree ||
      await graphGit(workspace.path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Agent commit workspace changed or has uncommitted modifications');
  await graphGit(job.repository, 'merge-base', '--is-ancestor', job.baseCommit, commit);
  return source;
}

/** Single-execution publication advances a ref by CAS, never creates an integration commit. */
export async function publishAgentCommit(args: { job: TaskGraphExecution; taskRunId: string; commit: string; integrationRef: string; expectedCommit: string }, tx: Prisma.TransactionClient = prisma) {
  await validateAgentCommit(tx, args.job, args.taskRunId, args.commit);
  if ((await graphGit(args.job.repository, 'worktree', 'list', '--porcelain')).split('\n').includes(`branch ${args.integrationRef}`)) throw new Error('Integration ref is checked out; preserve that workspace');
  const current = await graphGit(args.job.repository, 'rev-parse', args.integrationRef);
  if (current === args.commit) return { commit: args.commit };
  if (current !== args.expectedCommit || !await graphGit(args.job.repository, 'merge-base', '--is-ancestor', current, args.commit).then(() => true, () => false)) {
    throw new TaskGraphGitError('integration_stale', 'Agent commit requires cross-branch integration outside this contract');
  }
  await graphGit(args.job.repository, 'update-ref', args.integrationRef, args.commit, current);
  return { commit: args.commit };
}

export async function assertAgentCommitEvidence(tx: Prisma.TransactionClient, jobs: TaskGraphExecution[]) {
  if (jobs.length !== 1) throw new Error('agent_commit_v1 supports one execution');
  const job = jobs[0], evidence = job.evidence;
  if (!job.taskRunId || !isRecord(evidence) || evidence.taskRunId !== job.taskRunId || evidence.integratedCommit !== job.commit ||
      !isRecord(evidence.implementation) || evidence.implementation.status !== 'delivered' || evidence.implementation.commit !== job.commit) throw new Error('Missing formal Agent delivery evidence');
  await validateAgentCommit(tx, job, job.taskRunId, job.commit);
}
