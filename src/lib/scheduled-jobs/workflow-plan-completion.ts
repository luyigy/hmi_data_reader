import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from './project-config';
import {
  readWorkflowContract,
  validateWorkflowDocuments,
  workflowFrontMatter,
} from './workflow-validator';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync(
  'git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' },
)).stdout.trim();

export async function completeWorkflowPlan(args: {
  project: ProjectConfig;
  planPath: string;
  contractPath: string;
  expectedHead: string;
  disposition?: 'complete' | 'cancel';
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
  if (await git(args.project.path, 'status', '--porcelain', '--', args.planPath)) {
    throw new Error('目标 PLAN 存在 staged、unstaged 或 untracked 改动，拒绝标记完成；若为上次操作残留，请先确认并恢复该文件。');
  }
  if (!args.contractPath || path.isAbsolute(args.contractPath) || args.contractPath.split('/').includes('..')) {
    throw new Error('Workflow contract 路径无效。');
  }

  const absolutePath = path.join(args.project.path, args.planPath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const metadata = workflowFrontMatter(content);
  if (metadata.doc_type !== 'PLAN') throw new Error('所选文档不是 PLAN。');
  if (['completed', 'superseded'].includes(String(metadata.doc_status))) {
    return { state: 'existing' as const, path: args.planPath, head };
  }
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!match) throw new Error('PLAN 缺少合法 YAML frontmatter。');
  const contract = await readWorkflowContract(
    args.project.path,
    head,
    args.contractPath,
    new AbortController().signal,
  );
  const { start_marker: promptStart, end_marker: promptEnd } = contract.prompt;
  const promptStarts = content.split(promptStart).length - 1;
  const promptEnds = content.split(promptEnd).length - 1;
  if (promptStarts !== promptEnds || promptStarts > 1) {
    throw new Error('PLAN 自动化 Prompt 标记必须成对且最多一对。');
  }
  const start = content.indexOf(promptStart);
  const end = content.indexOf(promptEnd, start + promptStart.length);
  if (promptStarts && end < 0) {
    throw new Error('PLAN 自动化 Prompt 标记必须成对且顺序正确。');
  }
  const cancelled = args.disposition === 'cancel';
  const yaml = match[1]
    .replace(/^doc_status:\s*.*$/m, `doc_status: ${cancelled ? 'superseded' : 'completed'}`)
    .replace(/^next_action:\s*.*$/m, `next_action: ${cancelled ? 'none' : 'await_acceptance'}`);
  const withoutPrompt = promptStarts
    ? content.slice(0, start) + content.slice(end + promptEnd.length)
    : content;
  const updated = withoutPrompt.replace(match[0], `---\n${yaml}\n---\n`);
  await validateWorkflowDocuments({
    cwd: args.project.path,
    ref: head,
    filePaths: [args.planPath],
    contractPath: args.contractPath,
    contentOverrides: { [args.planPath]: updated },
  });

  const cleanup = async () => {
    await git(args.project.path, 'restore', '--staged', '--', args.planPath).catch(() => undefined);
    await git(args.project.path, 'restore', '--source=HEAD', '--', args.planPath)
      .catch(() => fs.writeFile(absolutePath, content, 'utf8'));
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
    await git(args.project.path, 'commit', '--no-verify', '--only', '-m',
      cancelled ? 'docs(workflow): cancel plan' : 'docs(workflow): mark plan complete', '--', args.planPath);
    return {
      state: cancelled ? 'cancelled' as const : 'completed' as const,
      path: args.planPath,
      head: await git(args.project.path, 'rev-parse', 'HEAD'),
    };
  } catch (error) {
    await cleanup();
    if (/index\.lock|another git process/i.test(String(error))) {
      throw new Error('Git 索引锁忙，请稍后重试。', { cause: error });
    }
    throw error;
  }
}
