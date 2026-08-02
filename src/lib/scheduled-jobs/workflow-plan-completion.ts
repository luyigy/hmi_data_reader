import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from './project-config';
import { workflowFrontMatter } from './workflow-validator';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync(
  'git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' },
)).stdout.trim();

export async function completeWorkflowPlan(args: {
  project: ProjectConfig;
  planPath: string;
  expectedHead: string;
}) {
  if (path.isAbsolute(args.planPath)
    || args.planPath.split('/').includes('..')
    || !/^docs\/(?:[^/]+\/)*\d+_PLAN_\d{8}_.+\.md$/.test(args.planPath)) {
    throw new Error('只能标记当前项目 docs 下的 PLAN 文档。');
  }
  if (!args.project.ref.startsWith('refs/heads/')) throw new Error('人工完成只支持 branch ref。');
  const checkedOutRef = await git(args.project.path, 'symbolic-ref', '--quiet', 'HEAD').catch(() => '');
  if (checkedOutRef !== args.project.ref) throw new Error(`目标工作区未检出 ${args.project.ref}。`);
  const head = await git(args.project.path, 'rev-parse', args.project.ref);
  if (head !== args.expectedHead) return { state: 'stale' as const, head };
  if (await git(args.project.path, 'status', '--porcelain')) throw new Error('目标工作区非 clean，拒绝标记完成。');

  const absolutePath = path.join(args.project.path, args.planPath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const metadata = workflowFrontMatter(content);
  if (metadata.doc_type !== 'PLAN') throw new Error('所选文档不是 PLAN。');
  if (['completed', 'superseded'].includes(String(metadata.doc_status))) {
    return { state: 'existing' as const, path: args.planPath, head };
  }
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!match) throw new Error('PLAN 缺少合法 YAML frontmatter。');
  const yaml = match[1]
    .replace(/^doc_status:\s*.*$/m, 'doc_status: completed')
    .replace(/^next_action:\s*.*$/m, 'next_action: await_acceptance');
  const updated = content.replace(match[0], `---\n${yaml}\n---\n`);
  const updatedMetadata = workflowFrontMatter(updated);
  if (updatedMetadata.doc_status !== 'completed' || updatedMetadata.next_action !== 'await_acceptance') {
    throw new Error('无法生成合法的 PLAN 完成状态。');
  }

  const cleanup = async () => {
    await git(args.project.path, 'restore', '--staged', '--', args.planPath).catch(() => undefined);
    await git(args.project.path, 'restore', '--source=HEAD', '--', args.planPath).catch(() => undefined);
  };
  try {
    await fs.writeFile(absolutePath, updated, 'utf8');
    const changes = (await git(args.project.path, 'status', '--porcelain', '--', args.planPath))
      .split('\n').filter(Boolean);
    if (changes.length !== 1 || changes[0] !== `M ${args.planPath}`) {
      throw new Error('PLAN 在提交前发生意外变化，拒绝标记完成。');
    }
    if ((await git(args.project.path, 'rev-parse', args.project.ref)) !== args.expectedHead) {
      await cleanup();
      return { state: 'stale' as const, head: await git(args.project.path, 'rev-parse', args.project.ref) };
    }
    await git(args.project.path, 'add', '--', args.planPath);
    await git(args.project.path, 'commit', '--only', '-m', 'docs(workflow): mark plan complete', '--', args.planPath);
    return {
      state: 'completed' as const,
      path: args.planPath,
      head: await git(args.project.path, 'rev-parse', 'HEAD'),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
