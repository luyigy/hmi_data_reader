import path from 'node:path';
import { parse } from 'yaml';
import { GitRefReader, type Reader } from './workflow-reader';

export { GitRefReader, WorkingTreeReader, type Reader } from './workflow-reader';

/** Thrown only when workflow documents themselves fail validation; runtime/infra
 * failures (missing contract, git errors, validator crashes) stay plain Errors so
 * callers such as the Git reference-transaction hook can tell the two apart. */
export type WorkflowValidationIssue = {
  code: string;
  severity: 'error' | 'warning';
  location: string;
  message: string;
  expected?: string;
  actual?: unknown;
  template: string;
};

export class WorkflowDocumentValidationError extends Error {
  constructor(message: string, public readonly issues: WorkflowValidationIssue[] = []) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WorkflowDocumentValidationError';
  }
}

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
      required_fields_by_kind: Record<string, string[]>;
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
  templates?: { plan?: string; handover?: string };
  validation?: { mode?: 'balanced' | 'strict'; rules?: Record<string, boolean> };
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
  reader: Reader = new GitRefReader(cwd, ref, signal),
) => {
  const source = await reader.read(contractPath);
  const contract = parse(source) as WorkflowContract;
  if (contract.schema_version !== 2) throw new Error(`unsupported workflow schema_version: ${contract.schema_version}`);
  strings(contract.documents?.automation_types, 'documents.automation_types');
  required(contract.documents?.filename_pattern, 'documents.filename_pattern');
  required(contract.documents?.slice_pattern, 'documents.slice_pattern');
  strings(contract.documents?.statuses, 'documents.statuses');
  strings(contract.documents?.common_required_fields, 'documents.common_required_fields');
  strings(contract.documents?.plan?.required_fields, 'documents.plan.required_fields');
  const planKinds = strings(contract.documents?.plan?.kinds, 'documents.plan.kinds');
  const requiredFieldsByKind = contract.documents?.plan?.required_fields_by_kind ?? {};
  if (typeof requiredFieldsByKind !== 'object' || Array.isArray(requiredFieldsByKind)
    || Object.entries(requiredFieldsByKind).some(([kind, fields]) =>
      !planKinds.includes(kind) || !strings(fields, `documents.plan.required_fields_by_kind.${kind}`))) {
    throw new Error('workflow contract has invalid documents.plan.required_fields_by_kind');
  }
  contract.documents.plan.required_fields_by_kind = requiredFieldsByKind;
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

class PromptMarkerError extends Error {
  constructor(
    public readonly code: 'PROMPT_MARKERS_MISSING' | 'PROMPT_MARKERS_INVALID' | 'PROMPT_FORBIDDEN',
    message: string,
    public readonly actual: string,
    public readonly fix: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const markerLines = (content: string, marker: string) => Array.from(content.matchAll(
  new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
), ({ index = 0 }) => content.slice(0, index).split('\n').length);

const promptFrom = (content: string, action: string, contract: WorkflowContract) => {
  const { start_marker: start, end_marker: end } = contract.prompt;
  const startLines = markerLines(content, start);
  const endLines = markerLines(content, end);
  const actual = `检测到 ${startLines.length} 个 start / ${endLines.length} 个 end 标记`;
  const locations = `start 行：${startLines.join('、') || '无'}；end 行：${endLines.join('、') || '无'}`;
  if (!contract.actions.executable.includes(action)) {
    if (startLines.length || endLines.length) throw new PromptMarkerError(
      'PROMPT_FORBIDDEN',
      '非可执行动作不得包含自动化 Prompt',
      actual,
      `删除所有 Prompt 标记及其内容（${locations}）`,
    );
    return '';
  }
  if (startLines.length !== 1 || endLines.length !== 1) {
    const missing = startLines.length === 0 || endLines.length === 0;
    const extra = startLines.length > 1 || endLines.length > 1;
    const fix = [extra && '删除多余标记，只保留一对', missing && '补齐缺失标记'].filter(Boolean).join('；');
    throw new PromptMarkerError(
      extra ? 'PROMPT_MARKERS_INVALID' : 'PROMPT_MARKERS_MISSING',
      extra ? '可执行动作的 Prompt 标记数量无效' : '可执行动作缺少 Prompt 标记',
      actual,
      `${fix}（${locations}）`,
    );
  }
  const prompt = content.slice(content.indexOf(start) + start.length, content.indexOf(end)).trim();
  if (!prompt) throw new Error('automation prompt is empty');
  return prompt;
};

const slices = (content: string, contract: WorkflowContract) => {
  const pattern = contract.documents.slice_pattern;
  const matches = content.matchAll(new RegExp(
    pattern.replace(/^\(\?m\)/, ''),
    pattern.startsWith('(?m)') ? 'gm' : 'g',
  ));
  return Array.from(new Set(Array.from(matches, (match) => match[1] ?? match[0].trim())))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
};

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
  reader: Reader = new GitRefReader(cwd, ref, signal),
) => {
  const issues: WorkflowValidationIssue[] = [];
  const policySeverity = (rule?: string) => {
    if (!rule) return 'error' as const;
    if (contract.validation?.rules?.[rule] === false) return null;
    return contract.validation?.mode === 'balanced' ? 'warning' as const : 'error' as const;
  };
  const issue = (
    code: string,
    location: string,
    message: string,
    expected?: string,
    actual?: unknown,
    rule?: string,
    template?: string,
  ) => {
    const severity = policySeverity(rule);
    if (!severity) return;
    const field = location.startsWith('YAML.') ? location.slice(5).split('/')[0] : '';
    issues.push({
      code,
      severity,
      location,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
      template: template ?? (location === 'Prompt'
        ? `${contract.prompt.start_marker}\n<下一 Session Prompt>\n${contract.prompt.end_marker}`
        : location === '正文'
          ? '## S01：<Slice 标题>'
          : `${field || location}: <值>`),
    });
  };
  const has = (field: string) => field in metadata;
  const hasValue = (field: string) => has(field) && metadata[field] !== null && metadata[field] !== '';
  for (const field of contract.documents.common_required_fields) {
    if (!has(field)) issue('REQUIRED_FIELD_MISSING', `YAML.${field}`, '缺少必填字段');
  }
  if (has('doc_type') && metadata.doc_type !== type) {
    issue('DOCUMENT_TYPE_MISMATCH', 'YAML.doc_type', '文件名类型与 doc_type 不一致', type, metadata.doc_type);
  }
  if (has('doc_status') && !contract.documents.statuses.includes(String(metadata.doc_status))) {
    issue('DOCUMENT_STATUS_INVALID', 'YAML.doc_status', '无效的文档状态', contract.documents.statuses.join('、'), metadata.doc_status);
  }
  const action = String(metadata.next_action);
  const validAction = has('next_action')
    && [...contract.actions.executable, ...contract.actions.terminal].includes(action);
  if (has('next_action') && !validAction) {
    issue(
      'NEXT_ACTION_INVALID',
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
      const markerError = error instanceof PromptMarkerError ? error : null;
      issue(
        error instanceof Error && error.message === 'automation prompt is empty'
          ? 'PROMPT_EMPTY'
          : markerError?.code ?? 'PROMPT_FORBIDDEN',
        'Prompt',
        error instanceof Error && error.message === 'automation prompt is empty'
          ? 'Prompt 标记之间的内容不能为空'
          : markerError?.message ?? '非可执行动作不得包含自动化 Prompt',
        contract.actions.executable.includes(action) ? '恰好一对 Prompt 标记' : '零个 Prompt 标记',
        markerError?.actual,
        undefined,
        markerError?.fix,
      );
    }
  }
  const requirePromptRefs = (...refs: string[]) => refs.forEach((item) => {
    if (prompt && !prompt.includes(item) && !prompt.includes(path.posix.basename(item))) {
      issue(
        'PROMPT_DOCUMENT_REFERENCE_MISSING',
        'Prompt',
        `缺少文档引用 ${path.posix.basename(item)}`,
        `${contract.prompt.start_marker} 与 ${contract.prompt.end_marker} 之间提及 ${path.posix.basename(item)}`,
        undefined,
        'prompt_must_reference_documents',
      );
    }
  });
  const readPlan = async (reference: unknown) => {
    const planPath = normalizeReference(reference, watchRoot);
    if (!await reader.exists(planPath)) throw new Error(`referenced PLAN does not exist: ${path.posix.basename(planPath)}`);
    const planContent = await reader.read(planPath);
    const planMetadata = workflowFrontMatter(planContent);
    if (planMetadata.doc_type !== 'PLAN') throw new Error(`referenced document is not a PLAN: ${path.posix.basename(planPath)}`);
    return { planPath, planContent, planMetadata };
  };

  if (type === 'PLAN') {
    const requiredFields = [
      ...contract.documents.plan.required_fields,
      ...(contract.documents.plan.required_fields_by_kind[String(metadata.plan_kind)] ?? []),
    ];
    requiredFields.forEach((field) => {
      if (!has(field)) issue('PLAN_REQUIRED_FIELD_MISSING', `YAML.${field}`, 'PLAN 缺少必填字段');
    });
    if (contract.actions.executable.includes(action) && !contract.documents.plan.executable_actions.includes(action)) {
      issue('PLAN_ACTION_INVALID', 'YAML.next_action', `PLAN 不能执行动作 ${action}`);
    }
    if (action === contract.documents.plan.start_action && has('doc_status')
      && metadata.doc_status !== contract.documents.plan.start_status) {
      issue(
        'PLAN_START_STATUS_INVALID',
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
        if (!await reader.exists(roadmap)) {
          issue('ROADMAP_NOT_FOUND', 'YAML.roadmap', `引用的 ROADMAP 不存在：${path.posix.basename(roadmap)}`);
        }
      } catch (error) {
        issue('ROADMAP_REFERENCE_INVALID', 'YAML.roadmap', error instanceof Error ? error.message : String(error));
      }
    }
    if (has('plan_kind') && !contract.documents.plan.kinds.includes(String(metadata.plan_kind))) {
      issue('PLAN_KIND_INVALID', 'YAML.plan_kind', '无效的 PLAN 类型', contract.documents.plan.kinds.join('、'), metadata.plan_kind);
    }
    if (metadata.plan_kind === contract.documents.plan.interrupt_kind) {
      if (contract.documents.plan.parent_fields.every(hasValue)) {
        try {
          const parent = await readPlan(metadata.parent_plan);
          const parentSlices = slices(parent.planContent, contract);
          for (const field of ['parent_slice', 'return_to']) {
            if (!parentSlices.includes(String(metadata[field]))) {
              issue(
                'PARENT_SLICE_NOT_FOUND',
                `YAML.${field}`,
                `父 PLAN 中不存在 ${field}`,
                parentSlices.join('、'),
                metadata[field],
                'referenced_slices_must_exist',
              );
            }
          }
        } catch (error) {
          issue('PARENT_PLAN_REFERENCE_INVALID', 'YAML.parent_plan', error instanceof Error ? error.message : String(error));
        }
      }
    } else if (metadata.plan_kind === contract.documents.plan.phase_kind
      && contract.documents.plan.parent_fields.some((field) => has(field) && metadata[field] !== null)) {
      issue('PHASE_PARENT_FIELDS_NON_NULL', 'YAML.parent_plan/parent_slice/return_to', 'phase PLAN 的父级字段必须为 null', undefined, undefined, 'phase_parent_fields_must_be_null');
    }
    const planSlices = slices(content, contract);
    if (!planSlices.length) issue('PLAN_SLICE_MISSING', '正文', 'PLAN 至少需要包含一个 Slice', undefined, undefined, 'plan_must_have_slice');
    else if (prompt && planSlices[0] && !prompt.includes(planSlices[0])) {
      issue('PROMPT_SLICE_REFERENCE_MISSING', 'Prompt', `启动 Prompt 未提及第一个 Slice ${planSlices[0]}`, undefined, undefined, 'prompt_must_reference_slice');
    }
    requirePromptRefs(filePath, ...(roadmap ? [roadmap] : []));
  } else {
    contract.documents.handover.required_fields.forEach((field) => {
      if (!has(field)) issue('HANDOVER_REQUIRED_FIELD_MISSING', `YAML.${field}`, 'HANDOVER 缺少必填字段');
    });
    if (has('plan_progress')
      && !contract.documents.handover.progress_values.includes(String(metadata.plan_progress))) {
      issue(
        'HANDOVER_PROGRESS_INVALID',
        'YAML.plan_progress',
        '无效的 PLAN 进度',
        contract.documents.handover.progress_values.join('、'),
        metadata.plan_progress,
      );
    }
    if (contract.actions.executable.includes(action) && !contract.documents.handover.executable_actions.includes(action)) {
      issue('HANDOVER_ACTION_INVALID', 'YAML.next_action', `HANDOVER 不能执行动作 ${action}`);
    }
    if (metadata.plan === null) {
      if (contract.actions.executable.includes(action)) {
        issue('STANDALONE_HANDOVER_EXECUTABLE', 'YAML.plan', '独立 HANDOVER 不能启动新 Session');
      }
    } else if (hasValue('plan')) {
      try {
        const plan = await readPlan(metadata.plan);
        const planSlices = slices(plan.planContent, contract);
        if (has('slice') && !planSlices.includes(String(metadata.slice))) {
          issue('HANDOVER_SLICE_NOT_FOUND', 'YAML.slice', '所属 PLAN 中不存在该 Slice', planSlices.join('、'), metadata.slice, 'referenced_slices_must_exist');
        }
        if (prompt) {
          let roadmap: string | undefined;
          if (plan.planMetadata.roadmap !== undefined && plan.planMetadata.roadmap !== null
            && plan.planMetadata.roadmap !== '') {
            try {
              roadmap = normalizeReference(plan.planMetadata.roadmap, watchRoot);
            } catch (error) {
              issue('PLAN_ROADMAP_REFERENCE_INVALID', 'YAML.plan/roadmap', error instanceof Error ? error.message : String(error));
            }
          }
          requirePromptRefs(filePath, plan.planPath, ...(roadmap ? [roadmap] : []));
          if (action === contract.documents.handover.next_action && has('slice')) {
            const current = planSlices.indexOf(String(metadata.slice));
            const nextSlice = planSlices[current + 1];
            const missingNext = !nextSlice;
            const missingPromptReference = nextSlice
              && !prompt.includes(nextSlice);
            if (missingNext || missingPromptReference) {
              issue(
                missingNext ? 'NEXT_SLICE_MISSING' : 'PROMPT_SLICE_REFERENCE_MISSING',
                'YAML.next_action/Prompt',
                missingNext
                  ? `${path.posix.basename(plan.planPath)} 的 ${String(metadata.slice)} 之后没有下一个 Slice`
                  : `Prompt 未提及下一个 Slice ${nextSlice}`,
                missingNext
                  ? `改用终止动作（${contract.actions.terminal.join('、')}），或在 PLAN 中添加下一个 Slice`
                  : `Prompt 提及 ${nextSlice}`,
                action,
                missingNext ? 'next_slice_must_exist' : 'prompt_must_reference_slice',
              );
            }
          } else if (action === contract.documents.handover.resume_action) {
            if (plan.planMetadata.plan_kind !== contract.documents.plan.interrupt_kind) {
              issue('RESUME_PARENT_PLAN_KIND_INVALID', 'YAML.next_action', 'resume_parent 动作要求所属 PLAN 为 interrupt 类型');
            } else {
              try {
                const parent = await readPlan(plan.planMetadata.parent_plan);
                const returnTo = String(plan.planMetadata.return_to);
                const missingReturnSlice = !slices(parent.planContent, contract).includes(returnTo);
                const missingPromptReference = !prompt.includes(returnTo);
                if (missingReturnSlice || missingPromptReference) {
                  issue(
                    missingReturnSlice ? 'RETURN_SLICE_NOT_FOUND' : 'PROMPT_SLICE_REFERENCE_MISSING',
                    'Prompt',
                    '恢复 Prompt 未提及有效的 return_to',
                    returnTo,
                    undefined,
                    missingReturnSlice ? 'referenced_slices_must_exist' : 'prompt_must_reference_slice',
                  );
                }
                requirePromptRefs(parent.planPath);
              } catch (error) {
                issue('PARENT_PLAN_REFERENCE_INVALID', 'YAML.plan/parent_plan', error instanceof Error ? error.message : String(error));
              }
            }
          }
        }
      } catch (error) {
        issue('PLAN_REFERENCE_INVALID', 'YAML.plan', error instanceof Error ? error.message : String(error));
      }
    }
  }
  const errors = issues.filter(({ severity }) => severity === 'error');
  if (errors.length) {
    throw new WorkflowDocumentValidationError(
      `${filePath}：共发现 ${errors.length} 个工作流文档错误\n`
      + issues.map((item, index) => `  ${index + 1}. [${item.severity} ${item.code}] [${item.location}] ${item.message}`
        + (item.expected === undefined ? '' : `；期望：${item.expected}`)
        + (item.actual === undefined ? '' : `；实际：${JSON.stringify(item.actual)}`)).join('\n')
      + '\n  修复并提交后由平台 completion gate 重新校验。',
      issues,
    );
  }
  // Compute nextSlice for HANDOVER next_slice actions so the watcher can
  // distinguish the handover slice from the target slice in its display.
  let nextSlice: string | undefined;
  if (type === 'HANDOVER' && action === contract.documents.handover.next_action && has('slice') && hasValue('plan')) {
    try {
      const plan = await readPlan(metadata.plan);
      const planSlices = slices(plan.planContent, contract);
      const current = planSlices.indexOf(String(metadata.slice));
      nextSlice = planSlices[current + 1];
    } catch { /* plan read failures are already surfaced as issues above */ }
  }
  return { action, prompt, issues, nextSlice };
};

export const validateWorkflowDocuments = async ({
  cwd,
  ref,
  contractRef = ref,
  filePaths,
  contractPath = 'docs/workflow/workflow-contract.yaml',
  signal = new AbortController().signal,
  contentOverrides = {},
  reader = new GitRefReader(cwd, ref, signal),
  contractReader = new GitRefReader(cwd, contractRef, signal),
}: {
  cwd: string;
  ref: string;
  contractRef?: string;
  filePaths: string[];
  contractPath?: string;
  signal?: AbortSignal;
  contentOverrides?: Record<string, string>;
  reader?: Reader;
  contractReader?: Reader;
}) => {
  const contract = await readWorkflowContract(cwd, contractRef, contractPath, signal, contractReader);
  if (contract.validation?.mode && !['balanced', 'strict'].includes(contract.validation.mode)) {
    throw new Error(`unsupported workflow validation mode: ${contract.validation.mode}`);
  }
  const templateIssues = (await Promise.all(Object.entries(contract.templates ?? {}).map(async ([type, filePath]) =>
    filePath && !await contractReader.exists(filePath)
      ? {
          code: 'TEMPLATE_MISSING',
          severity: 'warning' as const,
          location: `templates.${type}`,
          message: `目标 ref 缺少 ${type.toUpperCase()} 权威模板`,
          expected: filePath,
          actual: null,
          template: `${type}: ${filePath}`,
        }
      : null))).filter(Boolean) as WorkflowValidationIssue[];
  const candidates = selectWorkflowCandidates(filePaths, contract);
  if (candidates.length !== filePaths.length) throw new Error('candidate is not a PLAN/HANDOVER workflow document');
  const results = await Promise.allSettled(candidates.map(async (candidate) => {
    if (candidate.rawNumber.length !== contract.numbering.width) {
      const issue: WorkflowValidationIssue = {
        code: 'DOCUMENT_NUMBER_WIDTH_INVALID',
        severity: 'error',
        location: '文件名.number',
        message: 'workflow document number has invalid width',
        expected: String(contract.numbering.width),
        actual: candidate.rawNumber.length,
        template: `${'<编号>'.padStart(contract.numbering.width, '0')}_${candidate.type}_YYYYMMDD_<主题>.md`,
      };
      throw new WorkflowDocumentValidationError(`${candidate.filePath}: ${issue.message}`, [issue]);
    }
    const content = contentOverrides[candidate.filePath]
      ?? await reader.read(candidate.filePath);
    let metadata: Record<string, unknown>;
    try {
      metadata = workflowFrontMatter(content);
    } catch (error) {
      const issue: WorkflowValidationIssue = {
        code: 'FRONT_MATTER_INVALID',
        severity: 'error',
        location: 'YAML',
        message: error instanceof Error ? error.message : String(error),
        template: '---\ndoc_type: <PLAN|HANDOVER>\ndoc_status: <状态>\nnext_action: <动作>\n---',
      };
      throw new WorkflowDocumentValidationError(issue.message, [issue]);
    }
    const result = await validateWorkflowDocument(
      cwd, ref, candidate.filePath, candidate.type, content, metadata,
      contract, path.posix.dirname(candidate.filePath), signal, reader,
    );
    return { filePath: candidate.filePath, ...result, issues: [...templateIssues, ...result.issues] };
  }));
  const documentFailures = results.flatMap((result, index) =>
    result.status === 'rejected' && result.reason instanceof WorkflowDocumentValidationError
      ? [`${candidates[index].filePath}: ${result.reason.message}`]
      : []);
  if (documentFailures.length) {
    const issues = results.flatMap((result) =>
      result.status === 'rejected' && result.reason instanceof WorkflowDocumentValidationError
        ? result.reason.issues
        : []);
    throw new WorkflowDocumentValidationError(
      `共 ${documentFailures.length} 份工作流文档校验失败：\n`
      + documentFailures.map((failure, index) => `${index + 1}) ${failure}`).join('\n'),
      issues,
    );
  }
  const runtimeFailure = results.find(
    (result) => result.status === 'rejected',
  );
  if (runtimeFailure?.status === 'rejected') throw runtimeFailure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<{
    filePath: string;
    action: string;
    prompt: string;
    issues: WorkflowValidationIssue[];
  }>).value);
};
