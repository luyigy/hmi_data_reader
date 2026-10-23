import { effectiveArchitectureReview, type GraphDefinition } from './domain';

export type ReviewDecision = { approved?: unknown; note?: unknown; failureKind?: unknown; failureKey?: unknown; executionIds?: unknown };
export type ReviewCheck = { id: string; name: string; executionIds: string[] };
export type QualityCheck = { name: string; passed: boolean; evidence: string };
export type ClassifiedReview =
  | { approved: true; note: string; checks?: QualityCheck[] }
  | { approved: false; note: string; failureKind: 'blocked_require_human' }
  | { approved: false; note: string; failureKind: 'in_scope_defect'; failureKey: string; executionIds: string[]; checks?: QualityCheck[] };

export function graphReviewChecks(definition: GraphDefinition, nodeKey: string, executions: { id: string; repository: string; key?: string }[]): ReviewCheck[] {
  const node = definition.nodes.find(item => item.key === nodeKey);
  if (!node) throw new Error(`Unknown review node ${nodeKey}`);
  return [
    ...(definition.deliveryContract === 'agent_owned_v1' ? node.executions.flatMap(job => {
      const config = job.launchConfig;
      if (!config || typeof config !== 'object' || !('checks' in config) || !Array.isArray(config.checks)) throw new Error('Approved execution checks missing');
      return config.checks.map(check => {
        if (!check || typeof check.name !== 'string' || !check.name.trim()) throw new Error('Approved execution check name missing');
        return { id: `execution:${encodeURIComponent(job.key)}:${encodeURIComponent(check.name)}`, name: check.name, executionIds: executions.filter(execution => 'key' in execution && execution.key === job.key).map(execution => execution.id) };
      });
    }) : []),
    ...node.acceptance.checks.map(name => ({ id: `acceptance:${encodeURIComponent(name)}`, name, executionIds: executions.map(job => job.id) })),
    ...(node.acceptance.integrationChecks || []).map(check => ({ id: `integration:${encodeURIComponent(check.repository)}:${encodeURIComponent(check.name)}`, name: check.name, executionIds: executions.filter(job => job.repository === check.repository).map(job => job.id) })),
    ...(effectiveArchitectureReview(definition, node) ? [{ id: 'architecture:scope', name: '架构边界与批准范围', executionIds: executions.map(job => job.id) }] : []),
  ];
}

export function resolveReviewCheck(key: unknown, checks: ReviewCheck[]) {
  if (typeof key !== 'string') return undefined;
  return checks.find(check => check.id === key);
}

export function classifyReview(value: unknown, checks: ReviewCheck[], requireEvidence = false): ClassifiedReview | null {
  if (!value || typeof value !== 'object' || !('approved' in value) || !('note' in value) || typeof value.note !== 'string' || !value.note.trim()) return null;
  let evidence: QualityCheck[] | undefined;
  if (requireEvidence) {
    if (!('checks' in value) || !Array.isArray(value.checks)) return null;
    evidence = [];
    for (const item of value.checks) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.passed !== 'boolean' || typeof item.evidence !== 'string' || !item.evidence.trim() || !checks.some(check => check.id === item.name) || evidence.some(check => check.name === item.name)) return null;
      evidence.push({ name: item.name, passed: item.passed, evidence: item.evidence });
    }
    if (checks.some(check => !evidence?.some(item => item.name === check.id))) return null;
    if (value.approved === true && evidence.some(check => !check.passed)) return null;
  }
  if (value.approved === true) return { approved: true, note: value.note, ...(evidence ? { checks: evidence } : {}) };
  if (value.approved !== false || !('failureKind' in value)) return null;
  if (value.failureKind === 'blocked_require_human') return { approved: false, note: value.note, failureKind: 'blocked_require_human' };
  if (value.failureKind !== 'in_scope_defect') return null;
  const check = resolveReviewCheck('failureKey' in value ? value.failureKey : null, checks);
  if (!check) return null;
  const targets = 'executionIds' in value ? value.executionIds : check.executionIds.length === 1 ? check.executionIds : null;
  if (!Array.isArray(targets) || !targets.length || !targets.every((target: unknown) => typeof target === 'string' && check.executionIds.includes(target)) || new Set(targets).size !== targets.length) return null;
  return { approved: false, note: value.note, failureKind: 'in_scope_defect', failureKey: check.id, executionIds: targets, ...(evidence ? { checks: evidence } : {}) };
}

export function reviewResultInstructions(marker: string, checks: ReviewCheck[], requireEvidence = false) {
  return (requireEvidence ? '\n在现有结论 JSON 中附 checks 数组，每个稳定 ID 恰好一条 {"name":"稳定检查 ID","passed":true或false,"evidence":"实际命令、输出/报告和固定版本"}。逐项执行批准入口；缺项、未测或失败不得批准。' : '') + `\n稳定检查 ID 和可回修执行：${JSON.stringify(checks)}。失败时从这些 ID 和 executionIds 中精确选择，不得猜测名称或归属。` +
    `\n最终答复仅用一行 ${marker} {"approved":true或false,"note":"实际证据与理由","failureKind":"in_scope_defect 或 blocked_require_human（失败时必填）","failureKey":"稳定检查 ID（范围内缺陷必填）","executionIds":["受影响执行 ID（范围内缺陷必填）"]}。`;
}
