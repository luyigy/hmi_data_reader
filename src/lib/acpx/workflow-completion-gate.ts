import { execFile } from 'node:child_process';
import { readWorkflowContract, selectWorkflowCandidates, validateWorkflowDocuments } from '@/lib/scheduled-jobs/workflow-validator';

const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });

const lines = (value: string) => value.split('\n').filter(Boolean);

export const getWorkflowCompletionBaseline = (cwd: string) =>
  git(cwd, 'rev-parse', 'HEAD');

export const assertWorkflowCompletion = async (cwd: string, baseline: string) => {
  const head = await git(cwd, 'rev-parse', 'HEAD');
  const contractPath = 'docs/workflow/workflow-contract.yaml';
  try {
    await git(cwd, 'cat-file', '-e', `${head}:${contractPath}`);
  } catch {
    return;
  }
  const contract = await readWorkflowContract(
    cwd,
    head,
    contractPath,
    new AbortController().signal,
  );
  const changed = selectWorkflowCandidates(
    lines(await git(cwd, 'diff', '--name-only', '--diff-filter=AM', baseline, head)),
    contract,
  ).map(({ filePath }) => filePath);
  const dirty = selectWorkflowCandidates(lines([
    await git(cwd, 'diff', '--name-only'),
    await git(cwd, 'diff', '--cached', '--name-only'),
    await git(cwd, 'ls-files', '--others', '--exclude-standard'),
  ].join('\n')), contract).map(({ filePath }) => filePath);

  if (dirty.length) {
    throw new Error(`workflow completion blocked: uncommitted workflow document(s): ${dirty.join(', ')}`);
  }
  if (changed.length) {
    try {
      await validateWorkflowDocuments({ cwd, ref: head, filePaths: changed });
    } catch (error) {
      throw new Error(`workflow completion blocked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};
