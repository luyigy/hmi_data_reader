import type { ExecutionPhase, ExecutionProgress } from './execution-progress';
import { executionRetryLimits } from './retry-limits';

const phases: Record<ExecutionPhase, { label: string; action: string }> = {
  prepare: { label: '准备', action: '核对输入与运行环境后启动实施' },
  implement: { label: '实施', action: '保存成果并运行批准的检查' },
  collect_result: { label: '补收结果', action: '补收执行结论，再核对交付与检查' },
  check: { label: '平台检查', action: '检查通过后集成；范围内缺陷进入有限回修' },
  integrate: { label: '集成', action: '核对合并结果，再进入架构复核与验收' },
  architecture: { label: '架构复核', action: '复核通过后进入验收；范围内缺陷进入有限回修' },
  acceptance: { label: '验收', action: '按批准模式收口交付，再放行依赖已满足的后继' },
};

export function formatExecutionProgress(progress: ExecutionProgress, passed: boolean) {
  const stopped = ['waiting_decision', 'ownership_attention', 'exhausted'].includes(progress.state);
  const next = passed ? '本节点已通过，协调器按依赖关系领取后继'
    : stopped ? '自动推进已暂停，处理动作见上方说明'
    : progress.state === 'ready' ? `协调器自动领取后继续${phases[progress.phase].label}${progress.nextRetryAt ? `（最早 ${progress.nextRetryAt}）` : ''}`
    : phases[progress.phase].action;
  const remaining = (key: keyof typeof executionRetryLimits) => Math.max(0, executionRetryLimits[key] - progress[key]);
  return [`当前阶段：${passed ? '已验收' : phases[progress.phase].label}`, `下一自动动作：${next}`,
    `剩余额度：回修 ${remaining('repairAttempts')} · 环境重试 ${remaining('platformAttempts')} · 结果补收 ${remaining('formatAttempts')} · 合流重试 ${remaining('integrationAttempts')}`].join('\n');
}
