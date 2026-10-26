import { effectiveArchitectureReview, type GraphDefinition } from './domain';

export type ReviewDecision = { approved?: unknown; note?: unknown; failureKind?: unknown; failureKey?: unknown; executionIds?: unknown };
export type ReviewCheck = { id: string; name: string; executionIds: string[] };
export type ClassifiedReview =
  | { approved: true; note: string }
  | { approved: false; note: string; failureKind: 'blocked_require_human' }
  | { approved: false; note: string; failureKind: 'environment_failed' }
  | { approved: false; note: string; failureKind: 'in_scope_defect'; failureKey: string; executionIds: string[] };

export function graphReviewChecks(definition: GraphDefinition, nodeKey: string, executions: { id: string; repository: string }[]): ReviewCheck[] {
  const node = definition.nodes.find(item => item.key === nodeKey);
  if (!node) throw new Error(`Unknown review node ${nodeKey}`);
  return [
    ...node.acceptance.checks.map(name => ({ id: `acceptance:${encodeURIComponent(name)}`, name, executionIds: executions.map(job => job.id) })),
    ...(node.acceptance.integrationChecks || []).map(check => ({ id: `integration:${encodeURIComponent(check.repository)}:${encodeURIComponent(check.name)}`, name: check.name, executionIds: executions.filter(job => job.repository === check.repository).map(job => job.id) })),
    ...(effectiveArchitectureReview(definition, node) ? [{ id: 'architecture:scope', name: '架构边界与批准范围', executionIds: executions.map(job => job.id) }] : []),
  ];
}

export function resolveReviewCheck(key: unknown, checks: ReviewCheck[]) {
  if (typeof key !== 'string') return undefined;
  return checks.find(check => check.id === key);
}

export function classifyReview(value: unknown, checks: ReviewCheck[]): ClassifiedReview | null {
  if (!value || typeof value !== 'object' || !('approved' in value) || !('note' in value) || typeof value.note !== 'string' || !value.note.trim()) return null;
  if (value.approved === true) return { approved: true, note: value.note };
  if (value.approved !== false || !('failureKind' in value)) return null;
  if (value.failureKind === 'blocked_require_human' || value.failureKind === 'environment_failed') return { approved: false, note: value.note, failureKind: value.failureKind };
  if (value.failureKind !== 'in_scope_defect') return null;
  const check = resolveReviewCheck('failureKey' in value ? value.failureKey : null, checks);
  if (!check) return null;
  const targets = 'executionIds' in value ? value.executionIds : check.executionIds.length === 1 ? check.executionIds : null;
  if (!Array.isArray(targets) || !targets.length || !targets.every((target: unknown) => typeof target === 'string' && check.executionIds.includes(target)) || new Set(targets).size !== targets.length) return null;
  return { approved: false, note: value.note, failureKind: 'in_scope_defect', failureKey: check.id, executionIds: targets };
}

export function reviewResultInstructions(marker: string, checks: ReviewCheck[]) {
  return `\n稳定检查 ID 和可回修执行：${JSON.stringify(checks)}。失败时从这些 ID 和 executionIds 中精确选择，不得猜测名称或归属。` +
    `\n最终答复仅用一行 ${marker} {"approved":true或false,"note":"实际证据与理由","failureKind":"in_scope_defect、environment_failed 或 blocked_require_human（失败时必填）","failureKey":"稳定检查 ID（范围内缺陷必填）","executionIds":["受影响执行 ID（范围内缺陷必填）"]}。环境、认证或工具不可用导致未完成验证时用 environment_failed；只有确需人补充材料、决定范围或批准权限时用 blocked_require_human。`;
}
