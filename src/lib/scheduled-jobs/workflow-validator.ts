import { execFile } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';

export type WorkflowContract = {
  schema_version: number;
  documents: {
    automation_types: string[];
    filename_pattern: string;
    slice_pattern: string;
    statuses: string[];
    common_required_fields: string[];
    plan: {
      required_fields: string[];
      kinds: string[];
      executable_actions: string[];
      start_action: string;
      start_status: string;
      interrupt_kind: string;
      phase_kind: string;
      parent_fields: string[];
    };
    handover: {
      required_fields: string[];
      progress_values: string[];
      executable_actions: string[];
      next_action: string;
      resume_action: string;
    };
  };
  actions: { executable: string[]; terminal: string[] };
  prompt: { start_marker: string; end_marker: string };
  completion_gate: { timeout_seconds: number };
  branch_spaces: { root: string };
  numbering: { width: number; unique: boolean; candidate_selection: string };
  legacy: { cutoff_commit?: string | null; automation_enabled: boolean };
};

export type WorkflowCandidate = {
  filePath: string;
  number: number;
  rawNumber: string;
  type: string;
};

const exec = (file: string, args: string[], signal: AbortSignal, cwd?: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });

const git = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  exec('git', ['-c', 'core.quotepath=false', ...args], signal, cwd);

const required = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`workflow contract missing ${label}`);
  return value;
};

const strings = (value: unknown, label: string) => {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`workflow contract has invalid ${label}`);
  }
  return value as string[];
};

export const readWorkflowContract = async (
  cwd: string,
  ref: string,
  contractPath: string,
  signal: AbortSignal,
) => {
  const source = await git(cwd, signal, 'show', `${ref}:${contractPath}`);
  const contract = parse(source) as WorkflowContract;
  if (contract.schema_version !== 2) throw new Error(`unsupported workflow schema_version: ${contract.schema_version}`);
  strings(contract.documents?.automation_types, 'documents.automation_types');
  required(contract.documents?.filename_pattern, 'documents.filename_pattern');
  required(contract.documents?.slice_pattern, 'documents.slice_pattern');
  strings(contract.documents?.statuses, 'documents.statuses');
  strings(contract.documents?.common_required_fields, 'documents.common_required_fields');
  strings(contract.documents?.plan?.required_fields, 'documents.plan.required_fields');
  strings(contract.documents?.plan?.kinds, 'documents.plan.kinds');
  strings(contract.documents?.plan?.parent_fields, 'documents.plan.parent_fields');
  strings(contract.documents?.handover?.required_fields, 'documents.handover.required_fields');
  strings(contract.documents?.handover?.progress_values, 'documents.handover.progress_values');
  const executable = strings(contract.actions?.executable, 'actions.executable');
  const terminal = strings(contract.actions?.terminal, 'actions.terminal');
  if (executable.some((action) => terminal.includes(action))) throw new Error('workflow action sets overlap');
  const planActions = strings(contract.documents.plan.executable_actions, 'documents.plan.executable_actions');
  const handoverActions = strings(contract.documents.handover.executable_actions, 'documents.handover.executable_actions');
  if ([...planActions, ...handoverActions].sort().join() !== [...executable].sort().join()) {
    throw new Error('document executable actions do not match actions.executable');
  }
  if (planActions.length !== 1 || planActions[0] !== contract.documents.plan.start_action) {
    throw new Error('PLAN executable actions do not match plan.start_action');
  }
  if ([contract.documents.handover.next_action, contract.documents.handover.resume_action].sort().join()
    !== [...handoverActions].sort().join()) {
    throw new Error('HANDOVER executable actions do not match next_action/resume_action');
  }
  required(contract.prompt?.start_marker, 'prompt.start_marker');
  required(contract.prompt?.end_marker, 'prompt.end_marker');
  if (!Number.isInteger(contract.completion_gate?.timeout_seconds)
    || contract.completion_gate.timeout_seconds <= 0) throw new Error('workflow contract has invalid completion_gate');
  required(contract.branch_spaces?.root, 'branch_spaces.root');
  required(contract.numbering?.width, 'numbering.width');
  required(contract.legacy?.automation_enabled, 'legacy.automation_enabled');
  if (contract.numbering.candidate_selection !== 'highest_changed_number') {
    throw new Error(`unsupported candidate_selection: ${contract.numbering.candidate_selection}`);
  }
  return contract;
};

export const workflowFrontMatter = (content: string) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('missing YAML front matter');
  const metadata = parse(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('workflow front matter must be a mapping');
  }
  return metadata as Record<string, unknown>;
};

export const selectWorkflowCandidates = (
  filePaths: string[],
  contract: WorkflowContract,
  watchRoot?: string,
) => {
  const filename = new RegExp(contract.documents.filename_pattern.replace(/\(\?P<[^>]+>/g, '('));
  return filePaths.flatMap((filePath) => {
    const match = filename.exec(path.posix.basename(filePath));
    if (!match
      || (watchRoot && path.posix.dirname(filePath) !== watchRoot)
      || !contract.documents.automation_types.includes(match[2])) return [];
    return [{ filePath, number: Number(match[1]), rawNumber: match[1], type: match[2] }];
  }).sort((left, right) => left.number - right.number || left.filePath.localeCompare(right.filePath));
};

const normalizeReference = (value: unknown, watchRoot: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('document reference is empty');
  const reference = value.replace(/^\.\//, '');
  const resolved = reference.includes('/') ? reference : path.posix.join(watchRoot, reference);
  if (path.posix.dirname(resolved) !== watchRoot || resolved.split('/').includes('..')) {
    throw new Error(`reference leaves workflow directory: ${value}`);
  }
  return resolved;
};

const promptFrom = (content: string, action: string, contract: WorkflowContract) => {
  const { start_marker: start, end_marker: end } = contract.prompt;
  const starts = content.split(start).length - 1;
  const ends = content.split(end).length - 1;
  if (!contract.actions.executable.includes(action)) {
    if (starts || ends) throw new Error(`${action} must not contain an automation prompt`);
    return '';
  }
  if (starts !== 1 || ends !== 1) throw new Error('executable action requires exactly one prompt marker pair');
  const prompt = content.slice(content.indexOf(start) + start.length, content.indexOf(end)).trim();
  if (!prompt) throw new Error('automation prompt is empty');
  return prompt;
};

const exists = (cwd: string, ref: string, filePath: string, signal: AbortSignal) =>
  git(cwd, signal, 'cat-file', '-e', `${ref}:${filePath}`).then(() => true, () => false);

const slices = (content: string, contract: WorkflowContract) =>
  Array.from(new Set(content.match(new RegExp(contract.documents.slice_pattern, 'g')) ?? []))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));

export const validateWorkflowDocument = async (
  cwd: string,
  ref: string,
  filePath: string,
  type: string,
  content: string,
  metadata: Record<string, unknown>,
  contract: WorkflowContract,
  watchRoot: string,
  signal: AbortSignal,
) => {
  for (const field of contract.documents.common_required_fields) required(metadata[field], field);
  if (metadata.doc_type !== type) throw new Error('filename type and doc_type differ');
  if (!contract.documents.statuses.includes(String(metadata.doc_status))) throw new Error(`invalid doc_status: ${metadata.doc_status}`);
  const action = String(metadata.next_action);
  if (![...contract.actions.executable, ...contract.actions.terminal].includes(action)) {
    throw new Error(`invalid next_action: ${action}`);
  }
  const prompt = promptFrom(content, action, contract);
  const requirePromptRefs = (...refs: string[]) => refs.forEach((item) => {
    if (prompt && !prompt.includes(item) && !prompt.includes(path.posix.basename(item))) {
      throw new Error(`automation prompt does not name ${path.posix.basename(item)}`);
    }
  });
  const readPlan = async (reference: unknown) => {
    const planPath = normalizeReference(reference, watchRoot);
    if (!await exists(cwd, ref, planPath, signal)) throw new Error(`referenced PLAN does not exist: ${path.posix.basename(planPath)}`);
    const planContent = await git(cwd, signal, 'show', `${ref}:${planPath}`);
    const planMetadata = workflowFrontMatter(planContent);
    if (planMetadata.doc_type !== 'PLAN') throw new Error(`referenced document is not a PLAN: ${path.posix.basename(planPath)}`);
    return { planPath, planContent, planMetadata };
  };

  if (type === 'PLAN') {
    contract.documents.plan.required_fields.forEach((field) => {
      if (!(field in metadata)) throw new Error(`PLAN missing YAML field: ${field}`);
    });
    if (contract.actions.executable.includes(action) && !contract.documents.plan.executable_actions.includes(action)) {
      throw new Error(`PLAN cannot execute ${action}`);
    }
    if (action === contract.documents.plan.start_action && metadata.doc_status !== contract.documents.plan.start_status) {
      throw new Error(`${action} requires doc_status ${contract.documents.plan.start_status}`);
    }
    const roadmap = normalizeReference(metadata.roadmap, watchRoot);
    if (!await exists(cwd, ref, roadmap, signal)) throw new Error(`referenced ROADMAP does not exist: ${path.posix.basename(roadmap)}`);
    if (!contract.documents.plan.kinds.includes(String(metadata.plan_kind))) throw new Error(`invalid plan_kind: ${metadata.plan_kind}`);
    if (metadata.plan_kind === contract.documents.plan.interrupt_kind) {
      contract.documents.plan.parent_fields.forEach((field) => required(metadata[field], field));
      const parent = await readPlan(metadata.parent_plan);
      if (!slices(parent.planContent, contract).includes(String(metadata.parent_slice))
        || !slices(parent.planContent, contract).includes(String(metadata.return_to))) {
        throw new Error('parent_slice or return_to is absent from parent PLAN');
      }
    } else if (metadata.plan_kind === contract.documents.plan.phase_kind
      && contract.documents.plan.parent_fields.some((field) => metadata[field] !== null)) {
      throw new Error('phase PLAN parent fields must be null');
    }
    const planSlices = slices(content, contract);
    if (prompt && (!planSlices.length || !prompt.includes(planSlices[0]))) throw new Error('start prompt does not name the first Slice');
    requirePromptRefs(filePath, roadmap);
  } else {
    contract.documents.handover.required_fields.forEach((field) => {
      if (!(field in metadata)) throw new Error(`HANDOVER missing YAML field: ${field}`);
    });
    if (!contract.documents.handover.progress_values.includes(String(metadata.plan_progress))) {
      throw new Error(`invalid plan_progress: ${metadata.plan_progress}`);
    }
    if (contract.actions.executable.includes(action) && !contract.documents.handover.executable_actions.includes(action)) {
      throw new Error(`HANDOVER cannot execute ${action}`);
    }
    if (metadata.plan === null) {
      if (contract.actions.executable.includes(action)) throw new Error('standalone HANDOVER cannot start a session');
    } else {
      const plan = await readPlan(metadata.plan);
      const planSlices = slices(plan.planContent, contract);
      if (!planSlices.includes(String(metadata.slice))) throw new Error('HANDOVER slice is absent from owning PLAN');
      if (prompt) {
        const roadmap = normalizeReference(plan.planMetadata.roadmap, watchRoot);
        requirePromptRefs(filePath, plan.planPath, roadmap);
        if (action === contract.documents.handover.next_action) {
          const current = planSlices.indexOf(String(metadata.slice));
          if (current + 1 >= planSlices.length || !prompt.includes(planSlices[current + 1])) {
            throw new Error('next action prompt does not name the next Slice');
          }
        } else if (action === contract.documents.handover.resume_action) {
          if (plan.planMetadata.plan_kind !== contract.documents.plan.interrupt_kind) {
            throw new Error('resume action requires an interrupt PLAN');
          }
          const parent = await readPlan(plan.planMetadata.parent_plan);
          const returnTo = String(plan.planMetadata.return_to);
          if (!slices(parent.planContent, contract).includes(returnTo) || !prompt.includes(returnTo)) {
            throw new Error('resume prompt does not name valid return_to');
          }
          requirePromptRefs(parent.planPath);
        }
      }
    }
  }
  return { action, prompt };
};

export const validateWorkflowDocuments = async ({
  cwd,
  ref,
  filePaths,
  contractPath = 'docs/workflow/workflow-contract.yaml',
  signal = new AbortController().signal,
}: {
  cwd: string;
  ref: string;
  filePaths: string[];
  contractPath?: string;
  signal?: AbortSignal;
}) => {
  const contract = await readWorkflowContract(cwd, ref, contractPath, signal);
  const candidates = selectWorkflowCandidates(filePaths, contract);
  if (candidates.length !== filePaths.length) throw new Error('candidate is not a PLAN/HANDOVER workflow document');
  return Promise.all(candidates.map(async (candidate) => {
    if (candidate.rawNumber.length !== contract.numbering.width) {
      throw new Error(`${candidate.filePath}: workflow document number has invalid width`);
    }
    const content = await git(cwd, signal, 'show', `${ref}:${candidate.filePath}`);
    const metadata = workflowFrontMatter(content);
    const result = await validateWorkflowDocument(
      cwd, ref, candidate.filePath, candidate.type, content, metadata,
      contract, path.posix.dirname(candidate.filePath), signal,
    );
    return { filePath: candidate.filePath, ...result };
  }));
};
