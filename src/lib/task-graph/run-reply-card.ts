import { formatGraphFailureSummary, graphFailureSummary } from './failure-summary';
import { parseImplementationResult, type ImplementationResult } from './implementation-result';
import type { TaskRun, TaskRunEvent, TaskRunParticipant, TaskRunInteractionRequest } from '@prisma/client';
import { redactSensitiveText } from '../redact-sensitive';
import type { ExecutionProgress } from './execution-progress';
import { formatExecutionProgress } from './progress-summary';

type ReplyRun = Pick<TaskRun, 'id' | 'status' | 'summary' | 'error'> & { participants: TaskRunParticipant[]; graphStatus?: string; graphProgress?: ExecutionProgress | null };
const labels: Record<string, string> = { running: '执行中', waiting_for_input: '等待确认', completed: '会话结束', failed: '执行失败', interrupted: '已中断', stopped: '已停止' };
const roles: Record<string, string> = { implementer: '实施者', reviewer: '架构审查', tester: '测试验收' };
const bounded = (content: string, limit: number) => {
  const safe = redactSensitiveText(content);
  return safe.length > limit ? `…（前文已省略，以下为最近输出）\n${safe.slice(-limit)}` : safe;
};

export function buildRunReplyCard(run: ReplyRun, history: TaskRunEvent[], requests: TaskRunInteractionRequest[] = [], output: Pick<TaskRunEvent, 'content'>[] = []) {
  const identity = run.participants.map((p) => `${roles[p.role] || p.role} · ${p.harnessNameSnapshot || p.harnessType || p.runner}`).join(' / ');
  const isTool = (event: TaskRunEvent) => {
    try { if (JSON.parse(event.metadata || '{}').kind === 'tool') return true; } catch { /* Legacy events may lack JSON metadata. */ }
    return event.content.startsWith('工具：');
  };
  const lines = (events: TaskRunEvent[]) => events.map(event => `${event.createdAt.toISOString().slice(11, 19)} UTC · ${event.content}`).join('\n\n');
  const tools = history.filter(isTool);
  const systems = history.filter(event => !isTool(event));
  const active = ['running', 'waiting_for_input', 'pending'].includes(run.status);
  const streamed = output.map(event => event.content).join('');
  const finalReply = run.participants.map(participant => participant.summary || participant.error || '').filter(Boolean).join('\n\n') || run.summary || run.error || streamed;
  let conclusion: ImplementationResult | null = null;
  if (!active && run.status === 'completed') {
    try { conclusion = parseImplementationResult(finalReply); } catch { /* Review and legacy replies have no implementation marker. */ }
  }
  const response = active ? streamed || '正在准备执行，尚无 Agent 回复。' : finalReply || '本轮没有最终回复。';
  const blocked = conclusion?.status === 'blocked' ? conclusion.note : null;
  const snippet = (value: string) => {
    const safe = redactSensitiveText(value).replace(/^TASK_GRAPH_IMPLEMENTATION.*$/gm, '').trim();
    const paragraph = safe.split(/\n\s*\n/).filter(Boolean).pop() || '详细记录见下方展开内容。';
    const plain = paragraph.replace(/[`*#]/g, '').replace(/\s+/g, ' ').trim();
    return plain.length > 180 ? plain.slice(0, 180) + '…' : plain;
  };
  const progress = run.graphProgress;
  const repairing = progress?.phase === 'implement' && progress.repairAttempts > 0 && ['ready', 'active'].includes(progress.state);
  const phaseFailure = progress?.lastFailure && progress.state !== 'waiting_for_user' && (progress.state !== 'active' || repairing || run.graphStatus === 'attention') ? progress.lastFailure.detail : null;
  const failureSummary = phaseFailure && progress?.lastFailure ? graphFailureSummary(progress.lastFailure, progress.state) : null;
  const progressStatus = progress?.state === 'waiting_for_user' ? progress.waitingKind === 'answered' ? '本轮已答复，可在本话题继续交流' : '等待你的回复，在本话题回答即可'
    : failureSummary && ['waiting_decision', 'exhausted', 'ownership_attention'].includes(progress?.state || '')
    ? failureSummary.requiresUserDecision ? '需你确认' : failureSummary.owner === 'implementer' ? '待实施回修' : '待平台处理'
    : progress?.state === 'exhausted' ? '待平台提出新的修复措施'
    : progress?.state === 'ownership_attention' ? '执行归属需核对，请确认当前写入者'
    : progress?.state === 'waiting_decision' ? '需决定，当前执行已暂停'
    : repairing ? '自动修复中，完成后重新检查'
    : progress?.state === 'ready' && progress.lastFailure ? '自动恢复中，等待下一轮执行' : null;
  const status = run.graphStatus === 'passed' ? '已完成，平台检查与验收通过' : progressStatus || (blocked ? '实施暂停，尚未交付' : run.graphStatus === 'attention' ? '任务需处理，尚未通过平台检查或验收'
    : conclusion?.status === 'delivered' ? '实施已提交结果，尚未代表验收通过' : labels[run.status] || run.status);
  const visible = `${status}\n${phaseFailure && progress?.lastFailure ? formatGraphFailureSummary(progress.lastFailure, progress.state) : snippet(conclusion?.note || response)}${progress ? `\n${formatExecutionProgress(progress, run.graphStatus === 'passed')}` : ''}`;
  const actions = (active ? requests : []).filter((request) => request.status === 'pending' && (!request.expiresAt || request.expiresAt.getTime() > Date.now()))
    .flatMap((request) => {
      let payload: unknown;
      try { payload = JSON.parse(request.rawPayload || '{}'); } catch { payload = null; }
      const supported = payload && typeof payload === 'object' && 'approvalSupported' in payload && payload.approvalSupported === true;
      if (request.requestKind !== 'permission_request') return [];
      return [
        { tag: 'markdown', content: bounded(`待确认：${request.message}`, 1000) },
        ...(['deny', ...(supported ? ['approve'] : [])]).map((decision) => ({ tag: 'button', type: decision === 'approve' ? 'primary_filled' : 'default',
          text: { tag: 'plain_text', content: decision === 'approve' ? '仅批准本次操作' : '拒绝' },
          behaviors: [{ type: 'callback', value: { cmd: `${decision}:${request.id}` } }] })),
      ];
    });
  return { schema: '2.0', config: { update_multi: true },
    header: { template: run.status === 'failed' ? 'red' : blocked || run.graphStatus === 'attention' || run.status === 'waiting_for_input' ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: `${identity || 'Harness'} · ${progressStatus || (blocked ? '实施暂停' : run.graphStatus === 'attention' ? '任务需处理' : labels[run.status] || run.status)}` } },
    body: { elements: [
      { tag: 'markdown', content: visible },
      ...(progress?.lastFailure ? [{ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '最近故障详情' } },
        elements: [{ tag: 'markdown', content: bounded(`当前阶段：${progress.phase}\n最近故障：${progress.lastFailure.code}\n${progress.lastFailure.detail}\n${progress.lastFailure.command?.join(' ') || ''}`, 10_000) }] }] : []),
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: active ? '展开本轮完整进度' : '展开本轮回复' } },
        elements: [{ tag: 'markdown', content: bounded(response, active ? 4000 : 2500) }] },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '系统信息详情' } },
        elements: [{ tag: 'markdown', content: bounded(`运行：${run.id}\n${lines(systems) || '暂无系统信息。'}`, 1200) }] },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: `工具调用详情 · 最近 ${tools.length} 条` } },
        elements: [{ tag: 'markdown', content: bounded(lines(tools) || '暂无工具调用。', 1800) }] },
      ...actions,
      { tag: 'markdown', content: '总体进度见父话题；详细记录可展开查看。' },
    ] } };
}
