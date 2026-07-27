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
  const issues: string[] = [];
  const issue = (location: string, message: string, expected?: string, actual?: unknown) => {
    issues.push(
      `[${location}] ${message}`
      + (expected === undefined ? '' : `；期望：${expected}`)
      + (actual === undefined ? '' : `；实际：${JSON.stringify(actual)}`),
    );
  };
  const has = (field: string) => field in metadata;
  const hasValue = (field: string) => has(field) && metadata[field] !== null && metadata[field] !== '';
  for (const field of contract.documents.common_required_fields) {
    if (!has(field)) issue(`YAML.${field}`, '缺少必填字段');
  }
  if (has('doc_type') && metadata.doc_type !== type) {
    issue('YAML.doc_type', '文件名类型与 doc_type 不一致', type, metadata.doc_type);
  }
  if (has('doc_status') && !contract.documents.statuses.includes(String(metadata.doc_status))) {
    issue('YAML.doc_status', '无效的文档状态', contract.documents.statuses.join('、'), metadata.doc_status);
  }
  const action = String(metadata.next_action);
  const validAction = has('next_action')
    && [...contract.actions.executable, ...contract.actions.terminal].includes(action);
  if (has('next_action') && !validAction) {
    issue(
      'YAML.next_action',
      '无效的下一步动作',
      [...contract.actions.executable, ...contract.actions.terminal].join('、'),
      metadata.next_action,
    );
  }
  let prompt = '';
  if (validAction) {
    try {
      prompt = promptFrom(content, action, contract);
    } catch (error) {
      issue(
        'Prompt',
        error instanceof Error && error.message === 'executable action requires exactly one prompt marker pair'
          ? '可执行动作必须包含且只能包含一对 Prompt 标记'
          : error instanceof Error && error.message === 'automation prompt is empty'
            ? 'Prompt 标记之间的内容不能为空'
            : '非可执行动作不得包含自动化 Prompt',
      );
    }
  }
  const requirePromptRefs = (...refs: string[]) => refs.forEach((item) => {
    if (prompt && !prompt.includes(item) && !prompt.includes(path.posix.basename(item))) {
      issue(
        'Prompt',
        `缺少文档引用 ${path.posix.basename(item)}`,
        `${contract.prompt.start_marker} 与 ${contract.prompt.end_marker} 之间提及 ${path.posix.basename(item)}`,
      );
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
      if (!has(field)) issue(`YAML.${field}`, 'PLAN 缺少必填字段');
    });
    if (contract.actions.executable.includes(action) && !contract.documents.plan.executable_actions.includes(action)) {
      issue('YAML.next_action', `PLAN 不能执行动作 ${action}`);
    }
    if (action === contract.documents.plan.start_action && has('doc_status')
      && metadata.doc_status !== contract.documents.plan.start_status) {
      issue(
        'YAML.doc_status',
        `动作 ${action} 要求指定文档状态`,
        contract.documents.plan.start_status,
        metadata.doc_status,
      );
    }
    let roadmap = '';
    if (hasValue('roadmap')) {
      try {
        roadmap = normalizeReference(metadata.roadmap, watchRoot);
        if (!await exists(cwd, ref, roadmap, signal)) {
          issue('YAML.roadmap', `引用的 ROADMAP 不存在：${path.posix.basename(roadmap)}`);
        }
      } catch (error) {
        issue('YAML.roadmap', error instanceof Error ? error.message : String(error));
      }
    }
    if (has('plan_kind') && !contract.documents.plan.kinds.includes(String(metadata.plan_kind))) {
      issue('YAML.plan_kind', '无效的 PLAN 类型', contract.documents.plan.kinds.join('、'), metadata.plan_kind);
    }
    if (metadata.plan_kind === contract.documents.plan.interrupt_kind) {
      if (contract.documents.plan.parent_fields.every(hasValue)) {
        try {
          const parent = await readPlan(metadata.parent_plan);
          if (!slices(parent.planContent, contract).includes(String(metadata.parent_slice))
            || !slices(parent.planContent, contract).includes(String(metadata.return_to))) {
            issue('YAML.parent_slice/return_to', '父 PLAN 中不存在 parent_slice 或 return_to');
          }
        } catch (error) {
          issue('YAML.parent_plan', error instanceof Error ? error.message : String(error));
        }
      }
    } else if (metadata.plan_kind === contract.documents.plan.phase_kind
      && contract.documents.plan.parent_fields.some((field) => metadata[field] !== null)) {
      issue('YAML.parent_plan/parent_slice/return_to', 'phase PLAN 的父级字段必须为 null');
    }
    const planSlices = slices(content, contract);
    if (!planSlices.length) issue('正文', 'PLAN 至少需要包含一个 Slice');
    else if (prompt && !prompt.includes(planSlices[0])) issue('Prompt', `启动 Prompt 未提及第一个 Slice ${planSlices[0]}`);
    requirePromptRefs(filePath, ...(roadmap ? [roadmap] : []));
  } else {
    contract.documents.handover.required_fields.forEach((field) => {
      if (!has(field)) issue(`YAML.${field}`, 'HANDOVER 缺少必填字段');
    });
    if (has('plan_progress')
      && !contract.documents.handover.progress_values.includes(String(metadata.plan_progress))) {
      issue(
        'YAML.plan_progress',
        '无效的 PLAN 进度',
        contract.documents.handover.progress_values.join('、'),
        metadata.plan_progress,
      );
    }
    if (contract.actions.executable.includes(action) && !contract.documents.handover.executable_actions.includes(action)) {
      issue('YAML.next_action', `HANDOVER 不能执行动作 ${action}`);
    }
    if (metadata.plan === null) {
      if (contract.actions.executable.includes(action)) {
        issue('YAML.plan', '独立 HANDOVER 不能启动新 Session');
      }
    } else if (hasValue('plan')) {
      try {
        const plan = await readPlan(metadata.plan);
        const planSlices = slices(plan.planContent, contract);
        if (has('slice') && !planSlices.includes(String(metadata.slice))) {
          issue('YAML.slice', '所属 PLAN 中不存在该 Slice', planSlices.join('、'), metadata.slice);
        }
        if (prompt) {
          let roadmap = '';
          try {
            roadmap = normalizeReference(plan.planMetadata.roadmap, watchRoot);
          } catch (error) {
            issue('YAML.plan/roadmap', error instanceof Error ? error.message : String(error));
          }
          requirePromptRefs(filePath, plan.planPath, ...(roadmap ? [roadmap] : []));
          if (action === contract.documents.handover.next_action && has('slice')) {
            const current = planSlices.indexOf(String(metadata.slice));
            if (current + 1 >= planSlices.length || !prompt.includes(planSlices[current + 1])) {
              issue(
                'YAML.next_action/Prompt',
                current + 1 >= planSlices.length
                  ? `${path.posix.basename(plan.planPath)} 的 ${String(metadata.slice)} 之后没有下一个 Slice`
                  : `Prompt 未提及下一个 Slice ${planSlices[current + 1]}`,
                current + 1 >= planSlices.length
                  ? `改用终止动作（${contract.actions.terminal.join('、')}），或在 PLAN 中添加下一个 Slice`
                  : `Prompt 提及 ${planSlices[current + 1]}`,
                action,
              );
            }
          } else if (action === contract.documents.handover.resume_action) {
            if (plan.planMetadata.plan_kind !== contract.documents.plan.interrupt_kind) {
              issue('YAML.next_action', 'resume_parent 动作要求所属 PLAN 为 interrupt 类型');
            } else {
              try {
                const parent = await readPlan(plan.planMetadata.parent_plan);
                const returnTo = String(plan.planMetadata.return_to);
                if (!slices(parent.planContent, contract).includes(returnTo) || !prompt.includes(returnTo)) {
                  issue('Prompt', '恢复 Prompt 未提及有效的 return_to', returnTo);
                }
                requirePromptRefs(parent.planPath);
              } catch (error) {
                issue('YAML.plan/parent_plan', error instanceof Error ? error.message : String(error));
              }
            }
          }
        }
      } catch (error) {
        issue('YAML.plan', error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (issues.length) {
    throw new Error(
      `${filePath}：共发现 ${issues.length} 个工作流文档错误\n`
      + issues.map((item, index) => `  ${index + 1}. ${item}`).join('\n')
      + `\n  修复后先校验：npm run workflow:validate -- ${ref} ${filePath}`
      + '\n  校验通过并提交后，在飞书发送：/ap job run workflow-watcher',
    );
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
  const results = await Promise.allSettled(candidates.map(async (candidate) => {
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
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [
      `${candidates[index].filePath}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    ]
    : []);
  if (failures.length) {
    throw new Error(
      `共 ${failures.length} 份工作流文档校验失败：\n`
      + failures.map((failure, index) => `${index + 1}) ${failure}`).join('\n'),
    );
  }
  return results.map((result) => (result as PromiseFulfilledResult<{
    filePath: string;
    action: string;
    prompt: string;
  }>).value);
};
