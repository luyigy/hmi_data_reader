import { redactSensitiveText } from '../redact-sensitive';
import type { ExecutionProgress } from './execution-progress';

type Failure = { code: string; detail: string; command?: string[]; action?: string; owner?: 'platform' | 'implementer' | 'user'; requiresUserDecision?: boolean; affectedPaths?: string[] };
export function graphFailureSummary(failure: Failure, _state: ExecutionProgress['state']) {
  const conflict = failure.code === 'integration_conflict';
  let paths = failure.affectedPaths || [];
  if (!paths.length && conflict) {
    try { const value: unknown = JSON.parse(failure.detail); if (value && typeof value === 'object' && 'integration' in value && value.integration && typeof value.integration === 'object' && 'paths' in value.integration && Array.isArray(value.integration.paths)) paths = value.integration.paths.filter((item: unknown): item is string => typeof item === 'string'); } catch {}
  }
  if (!paths.length) paths = (failure.command || []).filter(value => /\.(py|tsx?|jsx?|json|md|ya?ml)$/.test(value));
  const labels: Record<string, string> = { integration_conflict: '代码集成出现冲突，双方修改已保留', environment_failed: '运行环境尚未准备就绪', runtime_capability_missing: '缺少本次验证所需的运行能力', runtime_resource_invalid: '运行资源与声明不一致', runtime_preflight_transient: '运行能力检查暂时失败', test_failed: '检查未通过，成果已保留', ownership_mismatch: '执行目录归属需要核对', permission_required: '需要确认本次权限', scope_change: '需要确认需求范围', missing_business_material: '必要业务材料尚未齐备', missing_upstream_input: '前置交付尚未绑定' };
  const humanKind = ['permission_required', 'scope_change'].includes(failure.code);
  const plainNote = !/^[\s]*[\[{]/.test(failure.detail) ? redactSensitiveText(failure.detail).replace(/\s+/g, ' ').trim().slice(0, 220) : '';
  const concreteNote = plainNote.length >= 8 ? plainNote : '';
  let requiresDecision = failure.requiresUserDecision ?? (humanKind && Boolean(concreteNote));
  let owner = failure.owner || (requiresDecision ? 'user' : conflict || failure.code.includes('environment') || failure.code.startsWith('runtime_') ? 'platform' : failure.code === 'test_failed' ? 'implementer' : 'platform');
  let action = failure.action || (requiresDecision && concreteNote ? `请确认这项请求：${concreteNote}` : conflict ? '核对列出的冲突文件并制定合并处理' : failure.code === 'test_failed' ? '修复失败检查后重新验证' : failure.code.includes('environment') || failure.code.startsWith('runtime_') ? '补齐并预检运行环境后继续' : '待平台补充处理说明');
  let problem = labels[failure.code] || '本次执行需要处理';
  if (requiresDecision && !failure.action?.trim() && !concreteNote) { requiresDecision = false; owner = 'platform'; problem = '待补充决定说明'; action = '平台先说明具体问题和可选处理办法'; }
  if (['scope_change', 'permission_required', 'missing_business_material', 'missing_upstream_input'].includes(failure.code) && concreteNote) problem += `：${concreteNote}`;
  const safePaths = paths.slice(0, 3).map(value => { const safe = redactSensitiveText(value); return safe.length <= 120 ? safe : '…/' + safe.split(/[\\/]/).slice(-2).join('/').slice(-116); });
  return { problem, action: redactSensitiveText(action).slice(0, 260), owner, requiresUserDecision: requiresDecision, affectedPaths: safePaths };
}
export function formatGraphFailureSummary(failure: Failure, state: ExecutionProgress['state']) {
  const summary = graphFailureSummary(failure, state);
  return [summary.problem, ...(summary.affectedPaths.length ? [`涉及文件：${summary.affectedPaths.join('、')}`] : []), `下一步：${summary.action}`,
    `负责人：${{ platform: '平台', implementer: '实施 Agent', user: '你' }[summary.owner]}；需要你决定：${summary.requiresUserDecision ? '是' : '否'}`].join('\n');
}
