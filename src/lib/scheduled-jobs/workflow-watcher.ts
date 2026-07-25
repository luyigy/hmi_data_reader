import { execFile } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';
import type { JobHandler } from './handlers';

type Contract = {
  documents: {
    automation_types: string[];
    filename_pattern: string;
    common_required_fields: string[];
    plan: { executable_actions: string[]; start_action: string };
    handover: { executable_actions: string[] };
  };
  actions: { executable: string[]; terminal: string[] };
  branch_spaces: { root: string };
  numbering: { width: number; unique: boolean; candidate_selection: string };
  legacy: { cutoff_commit?: string | null; automation_enabled: boolean };
};

type Cursor = { commit: string; eventKey?: string };

const git = (cwd: string, signal: AbortSignal, ...args: string[]) => new Promise<string>((resolve, reject) => {
  execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    signal,
  }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message));
    else resolve(stdout);
  });
});

const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined || value === null) throw new Error(`workflow contract missing ${label}`);
  return value;
};

const readContract = async (
  cwd: string,
  head: string,
  contractPath: string,
  signal: AbortSignal,
) => {
  const source = await git(cwd, signal, 'show', `${head}:${contractPath}`);
  const contract = parse(source) as Contract;
  required(contract.documents?.automation_types, 'documents.automation_types');
  required(contract.documents?.filename_pattern, 'documents.filename_pattern');
  required(contract.actions?.executable, 'actions.executable');
  required(contract.actions?.terminal, 'actions.terminal');
  required(contract.branch_spaces?.root, 'branch_spaces.root');
  required(contract.numbering?.width, 'numbering.width');
  required(contract.legacy?.automation_enabled, 'legacy.automation_enabled');
  if (contract.numbering.candidate_selection !== 'highest_changed_number') {
    throw new Error(`unsupported candidate_selection: ${contract.numbering.candidate_selection}`);
  }
  return contract;
};

const frontMatter = (content: string) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('missing YAML front matter');
  const metadata = parse(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('workflow front matter must be a mapping');
  }
  return metadata as Record<string, unknown>;
};

const workflowCursor = (cursor: unknown, initialCommit: unknown): Cursor => {
  if (cursor && typeof cursor === 'object' && 'commit' in cursor && typeof cursor.commit === 'string') {
    return cursor as Cursor;
  }
  if (typeof initialCommit !== 'string' || !initialCommit) {
    throw new Error('workflow_watcher requires config.initial_cursor_commit for first shadow run');
  }
  return { commit: initialCommit };
};

export const workflowWatcherHandler: JobHandler = async ({ project, job, mode, cursor, signal }) => {
  if (mode !== 'shadow') throw new Error('workflow_watcher active mode is not enabled');
  const contractPath = String(job.config.contract_path || '');
  if (!contractPath || path.isAbsolute(contractPath) || contractPath.split('/').includes('..')) {
    throw new Error('contract_path must stay inside the repository');
  }

  const head = (await git(project.path, signal, 'rev-parse', '--verify', `${project.ref}^{commit}`)).trim();
  const previous = workflowCursor(cursor, job.config.initial_cursor_commit);
  const contract = await readContract(project.path, head, contractPath, signal);
  const ancestor = await git(project.path, signal, 'merge-base', '--is-ancestor', previous.commit, head)
    .then(() => true, () => false);
  if (!ancestor) throw new Error('configured Git ref was rewritten; human review required');
  if (contract.legacy.cutoff_commit) {
    const aboveCutoff = await git(project.path, signal, 'merge-base', '--is-ancestor', contract.legacy.cutoff_commit, previous.commit)
      .then(() => true, () => false);
    if (!aboveCutoff) throw new Error('cursor precedes contract cutoff; human review required');
  }

  const branchSpace = String(job.config.branch_space || '');
  if (!branchSpace || branchSpace.includes('/') || branchSpace === '.' || branchSpace === '..') {
    throw new Error('workflow_watcher requires a single-directory config.branch_space');
  }
  const watchRoot = path.posix.join(contract.branch_spaces.root, branchSpace);
  const changed = previous.commit === head ? [] : (await git(
    project.path,
    signal,
    'diff',
    '--name-only',
    '--diff-filter=AMR',
    previous.commit,
    head,
    '--',
    watchRoot,
  )).trim().split('\n').filter(Boolean);
  const filename = new RegExp(contract.documents.filename_pattern.replace(/\(\?P<[^>]+>/g, '('));
  const candidates = changed.flatMap((filePath) => {
    const match = filename.exec(path.posix.basename(filePath));
    if (!match || path.posix.dirname(filePath) !== watchRoot || !contract.documents.automation_types.includes(match[2])) return [];
    return [{ filePath, number: Number(match[1]), rawNumber: match[1], type: match[2] }];
  }).sort((left, right) => left.number - right.number || left.filePath.localeCompare(right.filePath));

  if (!candidates.length) return { summary: `head=${head} candidate=none`, cursor: { commit: head } };
  const candidate = candidates.at(-1)!;
  if (candidate.rawNumber.length !== contract.numbering.width) throw new Error('workflow document number has invalid width');
  if (contract.numbering.unique && candidates.filter((item) => item.number === candidate.number).length !== 1) {
    throw new Error(`multiple workflow documents use number ${candidate.number}`);
  }

  const content = await git(project.path, signal, 'show', `${head}:${candidate.filePath}`);
  const metadata = frontMatter(content);
  for (const field of contract.documents.common_required_fields) required(metadata[field], field);
  if (metadata.doc_type !== candidate.type) throw new Error('filename type and doc_type differ');
  const action = String(metadata.next_action);
  if (![...contract.actions.executable, ...contract.actions.terminal].includes(action)) {
    throw new Error(`invalid next_action: ${action}`);
  }
  if (candidate.type === 'PLAN' && !contract.documents.plan.executable_actions.includes(action)
    && contract.actions.executable.includes(action)) throw new Error(`PLAN cannot execute ${action}`);
  if (candidate.type === 'HANDOVER' && !contract.documents.handover.executable_actions.includes(action)
    && contract.actions.executable.includes(action)) throw new Error(`HANDOVER cannot execute ${action}`);

  const blob = (await git(project.path, signal, 'rev-parse', `${head}:${candidate.filePath}`)).trim();
  const eventKey = `${head}:${candidate.filePath}:${blob}:${action}`;
  const gate = !contract.legacy.automation_enabled
    ? 'automation_disabled'
    : candidate.type === 'PLAN' && action === contract.documents.plan.start_action
      ? 'plan_review'
      : contract.actions.executable.includes(action)
        ? 'workflow_ready'
        : 'terminal';
  return {
    summary: `head=${head} candidate=${candidate.filePath} type=${candidate.type} action=${action} gate=${gate}`,
    cursor: { commit: head, eventKey },
  };
};
