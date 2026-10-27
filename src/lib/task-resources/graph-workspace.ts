import { graphResourceJobs } from '../task-graph/graph-association';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../prisma';
import { workspacePath, workspaceIdentity } from '../workspace-layout';
import { graphGit } from '../task-graph/git-command';
import { withRepositoryLock } from '../task-graph/repository-lock';
import { linkedWorktreeGitDirectories } from '../real-agents/git-worktree-paths';
import type { TaskInputManifest } from '../task-graph/upstream-inputs';
import type { ResourceDirectory } from './model';
import type { AcpxRunRequest } from '../acpx/types';

/** A directory grant permits editing a private copy; it never changes a pinned input or delivery scope. */
export async function prepareResourceWorkspaces(request: AcpxRunRequest, resources: ResourceDirectory[], manifests: TaskInputManifest[]) {
  const mappings: { repository: string; commit: string; checkout: string; approvalPath: string }[] = [];
  const protectedPaths: string[] = [];
  const write: string[] = [];
  const candidateInstructions: string[] = [];
  for (const resource of resources.filter(item => item.access === 'write')) {
    const inputs = manifests.flatMap(manifest => manifest.inputs).filter(item => item.repository === resource.canonicalPath);
    if (new Set(inputs.map(input => input.commit)).size > 1) throw new Error('补充源码对应多个固定版本，不能猜测可写副本的候选');
    const input = inputs[0];
    if (!input) { write.push(resource.canonicalPath); continue; }
    const jobs = await graphResourceJobs(request.taskId);
    const job = jobs.find(job => manifests.some(manifest => manifest.executionId === job.id && manifest.inputs.includes(input)));
    if (!job || request.graphExecution && (job.id !== request.graphExecution.executionId || job.claimToken !== request.graphExecution.claimToken)) throw new Error('资源工作区的固定输入或执行身份改变');
    const checkout = await withRepositoryLock(input.repository, async () => {
      const directory = await workspacePath(input.repository, 'development', [`resource-${job.id}`, input.commit]);
      const key = `resource-workspace:${job.id}:${workspaceIdentity(input.repository)}:${input.commit}`;
      const previous = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: job.node.runId, idempotencyKey: key } } });
      const registry = await graphGit(input.repository, 'worktree', 'list', '--porcelain');
      const registered = registry.split('\n\n').some(block => block.split('\n').includes(`worktree ${directory}`));
      if (!registered) {
        if (previous || await fs.lstat(directory).then(() => true, () => false)) throw new Error('资源工作区登记不一致，保留现场');
        await fs.mkdir(path.dirname(directory), { recursive: true });
        await graphGit(input.repository, 'worktree', 'add', '--detach', directory, input.commit);
      }
      const info = await fs.stat(directory, { bigint: true });
      const identity = { repository: input.repository, commit: input.commit, checkout: directory, device: String(info.dev), inode: String(info.ino) };
      if (await graphGit(directory, 'rev-parse', 'HEAD') !== input.commit ||
        await graphGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== await graphGit(input.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw new Error('资源工作区基线或 Git 身份改变');
      if (previous) {
        const saved = previous.payload as Record<string, unknown>;
        if (Object.entries(identity).some(([key, value]) => saved[key] !== value)) throw new Error('资源工作区目录身份改变');
      }
      if (!previous) {
        if (await graphGit(directory, 'status', '--porcelain', '--untracked-files=all')) throw new Error('未登记资源工作区已有修改，保留现场');
        await prisma.taskGraphEvent.create({ data: { runId: job.node.runId, nodeId: job.nodeId, kind: 'resource_workspace_prepared', idempotencyKey: key, payload: identity } });
      }
      return directory;
    });
    mappings.push({ repository: input.repository, commit: input.commit, checkout, approvalPath: resource.path });
    candidateInstructions.push(input.replacement
      ? `${input.repository} 的正式交付候选已登记为 ${input.commit}（${input.replacement.eventId}），允许主仓消费并提交验收；实际校验使用固定 sourcePath ${input.sourcePath}。checkout 仅供获批回修；新增修改须由平台另行固化再验证，不自行提交或汇合。`
      : `${input.repository} 保留未提交修改，不提交或汇合额外仓，正式交付范围另行确认。`);
    write.push(checkout);
    protectedPaths.push(resource.canonicalPath, path.join(checkout, '.git'), ...linkedWorktreeGitDirectories(checkout));
  }
  return { write, protectedPaths, mappings,
    instructions: mappings.length ? `\n已批准目录对应的可写隔离源码：${JSON.stringify(mappings)}。请在 checkout 编辑和验证，原 repository 和固定输入 sourcePath 保持只读。工作目录和 Native Session 不变。${candidateInstructions.join('\n')}` : '' };
}
