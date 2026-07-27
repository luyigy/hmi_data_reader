import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readWorkflowContract, selectWorkflowCandidates, validateWorkflowDocuments } from '@/lib/scheduled-jobs/workflow-validator';

const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });

const lines = (value: string) => value.split('\n').filter(Boolean);

export type WorkflowCompletionBaseline = {
  head: string;
  dirty: Record<string, string>;
};

export class WorkflowCompletionValidationError extends Error {
  constructor(
    message: string,
    readonly head: string,
    readonly filePaths: string[],
  ) {
    super(`workflow completion blocked: ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WorkflowCompletionValidationError';
  }

  get fingerprint() {
    return createHash('sha256')
      .update(this.message.replace(/[0-9a-f]{40}/gi, '<commit>').replace(/\s+/g, ' ').trim())
      .digest('hex');
  }
}

export const shouldCheckWorkflowCompletion = (
  enabled: boolean | undefined,
  executionBackend: string,
) => enabled === true && executionBackend === 'platform_local';

const getDirtyWorkflowDocuments = async (cwd: string, ref: string) => {
  const contract = await readWorkflowContract(
    cwd,
    ref,
    'docs/workflow/workflow-contract.yaml',
    new AbortController().signal,
  );
  return selectWorkflowCandidates(lines([
    await git(cwd, 'diff', '--name-only'),
    await git(cwd, 'diff', '--cached', '--name-only'),
    await git(cwd, 'ls-files', '--others', '--exclude-standard'),
  ].join('\n')), contract).map(({ filePath }) => filePath);
};

const getDirtyWorkflowSnapshot = async (cwd: string, ref: string) =>
  Object.fromEntries(await Promise.all((await getDirtyWorkflowDocuments(cwd, ref)).map(async (filePath) => [
    filePath,
    [
      await git(cwd, 'diff', '--binary', '--', filePath),
      await git(cwd, 'diff', '--cached', '--binary', '--', filePath),
      await git(cwd, 'ls-files', '--others', '--exclude-standard', '--', filePath)
        ? await git(cwd, 'hash-object', '--', filePath)
        : '',
    ].join('\0'),
  ])));

export const getWorkflowCompletionBaseline = async (cwd: string): Promise<WorkflowCompletionBaseline> => {
  const head = await git(cwd, 'rev-parse', 'HEAD');
  try {
    await git(cwd, 'cat-file', '-e', `${head}:docs/workflow/workflow-contract.yaml`);
  } catch {
    return { head, dirty: {} };
  }
  return { head, dirty: await getDirtyWorkflowSnapshot(cwd, head) };
};

export const assertWorkflowCompletion = async (cwd: string, baseline: WorkflowCompletionBaseline) => {
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
    lines(await git(cwd, 'diff', '--name-only', '--diff-filter=AM', baseline.head, head)),
    contract,
  ).map(({ filePath }) => filePath);
  const dirtySnapshot = await getDirtyWorkflowSnapshot(cwd, head);
  const dirty = Object.keys(dirtySnapshot)
    .filter((filePath) => dirtySnapshot[filePath] !== baseline.dirty[filePath]);

  if (dirty.length) {
    throw new Error(`workflow completion blocked: uncommitted workflow document(s): ${dirty.join(', ')}`);
  }
  if (changed.length) {
    try {
      await validateWorkflowDocuments({ cwd, ref: head, filePaths: changed });
    } catch (error) {
      throw new WorkflowCompletionValidationError(
        error instanceof Error ? error.message : String(error),
        head,
        changed,
      );
    }
  }
};

export const completeWorkflowWithCorrections = async (
  cwd: string,
  baseline: WorkflowCompletionBaseline,
  correct: (error: WorkflowCompletionValidationError, attempt: number) => Promise<void>,
) => {
  let previousFingerprint: string | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await assertWorkflowCompletion(cwd, baseline);
      return;
    } catch (error) {
      if (!(error instanceof WorkflowCompletionValidationError)) throw error;
      if (error.fingerprint === previousFingerprint) {
        throw new Error(`${error.message}\nworkflow correction stopped: validation errors unchanged`);
      }
      if (attempt >= 2) {
        throw new Error(`${error.message}\nworkflow correction stopped: maximum 2 attempts reached`);
      }
      previousFingerprint = error.fingerprint;
      await correct(error, attempt + 1);
    }
  }
};
