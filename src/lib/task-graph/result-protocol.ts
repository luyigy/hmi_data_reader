import { parseImplementationResult, type ImplementationResult } from './implementation-result';
import { classifyReview, type ClassifiedReview, type ReviewCheck } from './review-contract';

export type GraphResultMarker = 'TASK_GRAPH_IMPLEMENTATION' | 'TASK_GRAPH_REVIEW' | 'TASK_GRAPH_ARCH_REVIEW';
export type GraphResult =
  | { kind: 'conversation' }
  | { kind: 'invalid'; note: string }
  | { kind: 'implementation'; result: ImplementationResult }
  | { kind: 'review'; decision: ClassifiedReview; verification?: unknown };

/** Both scheduled and human turns use the existing wire format. Prose is never a submission. */
export function parseGraphResult(output: string, marker: string, checks: ReviewCheck[] = []): GraphResult {
  const lines = output.split(/\r?\n/).filter(line => /^[ \t]*TASK_GRAPH_(?:IMPLEMENTATION|ARCH_REVIEW|REVIEW)\b/.test(line));
  if (!lines.length) return { kind: 'conversation' };
  if (lines.length !== 1) return { kind: 'invalid', note: '正式结果必须唯一；本次含有多个 TASK_GRAPH 结果，不自动选择其中一个' };
  const match = lines[0].match(/^[ \t]*(TASK_GRAPH_IMPLEMENTATION|TASK_GRAPH_ARCH_REVIEW|TASK_GRAPH_REVIEW)[ \t]+(\{[^\r\n]+\})[ \t]*$/);
  if (!match) return { kind: 'invalid', note: '正式结果格式无效：须为一行结果标记及 JSON 对象' };
  if (match[1] !== marker) return { kind: 'invalid', note: `结果角色不匹配：本次需要 ${marker}，收到 ${match[1]}` };
  try {
    if (marker === 'TASK_GRAPH_IMPLEMENTATION') return { kind: 'implementation', result: parseImplementationResult(lines[0].trim(), { reviewChecks: checks }) };
    const raw = JSON.parse(match[2]);
    const decision = classifyReview(raw, checks);
    if (!decision) return { kind: 'invalid', note: '复核结论缺少有效说明、稳定检查 ID 或执行归属' };
    return { kind: 'review', decision, ...(raw.verification !== undefined ? { verification: raw.verification } : {}) };
  } catch (error) { return { kind: 'invalid', note: error instanceof Error ? error.message : String(error) }; }
}
