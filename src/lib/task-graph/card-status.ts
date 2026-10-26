import type { ExecutionProgress } from './execution-progress';
import { graphFailureSummary } from './failure-summary';

const styles = {
  green: { template: 'green', icon: '🟢' }, red: { template: 'red', icon: '🔴' },
  yellow: { template: 'yellow', icon: '🟡' }, blue: { template: 'blue', icon: '🔵' }, grey: { template: 'grey', icon: '⚪' },
} as const;
const display = (color: keyof typeof styles, label: string) => ({ ...styles[color], label });

/** Presentation of persisted state only; never decides acceptance or releases dependencies. */
export function graphCardStatus(status: string | undefined, progresses: (ExecutionProgress | null | undefined)[] = []) {
  if (status === 'passed') return display('green', '已完成 · 检查通过');
  if (status === 'delivered_unverified') return display('green', '已按合同交付 · 未独立验收');
  if (status === 'awaiting_human') return display('yellow', '待人工确认');
  if (status === 'attention') {
    const waiting = progresses.filter(p => p && !['ready', 'active'].includes(p.state));
    const incomplete = waiting.find(p => p?.lastFailure && ['review_platform_failure', 'invalid_review_result', 'environment_failed'].includes(p.lastFailure.code) && ['acceptance', 'architecture'].includes(p.phase));
    if (incomplete) return display('red', incomplete.phase === 'acceptance' ? '验收未完成 · 执行异常' : '架构审查未完成 · 执行异常');
    if (waiting.some(p => p?.lastFailure && p.phase === 'acceptance')) return display('red', '验收未通过');
    if (waiting.some(p => p?.lastFailure && p.phase === 'architecture')) return display('red', '架构审查未通过');
    if (waiting.some(p => p?.lastFailure && !graphFailureSummary(p.lastFailure, p.state).requiresUserDecision)) return display('red', '执行异常 · 待处理');
    if (waiting.some(p => p?.waitingKind === 'question' || p?.lastFailure && graphFailureSummary(p.lastFailure, p.state).requiresUserDecision)) return display('yellow', '待你确认或补充');
    return display('red', '任务需处理');
  }
  if (status === 'planned') return display('grey', '等待前置');
  if (status === 'verifying') return display('blue', '验收中');
  if (status === 'ready') return display('blue', '准备执行');
  return display('blue', '执行中');
}
