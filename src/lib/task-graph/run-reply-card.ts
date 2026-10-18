import { parseImplementationResult } from './implementation-result';
import type { TaskRun, TaskRunEvent, TaskRunParticipant, TaskRunInteractionRequest } from '@prisma/client';
import { redactSensitiveText } from '../redact-sensitive';

type ReplyRun = Pick<TaskRun, 'id' | 'status' | 'summary' | 'error'> & { participants: TaskRunParticipant[] };
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
  let blocked: string | null = null;
  if (!active && run.status === 'completed') {
    try { const result = parseImplementationResult(finalReply); if (result.status === 'blocked') blocked = result.note; } catch { /* Review and legacy replies have no implementation marker. */ }
  }
  const response = active ? streamed || '正在准备执行，尚无 Agent 回复。' : finalReply || '本轮没有最终回复。';
  const visible = blocked ? `实施暂停：${bounded(blocked, 1200)}\n\n进度已保存，尚未交付。` : bounded(response, active ? 1000 : 2500);
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
    header: { template: run.status === 'failed' ? 'red' : blocked || run.status === 'waiting_for_input' ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: `${identity || 'Harness'} · ${blocked ? '实施暂停' : labels[run.status] || run.status}` } },
    body: { elements: [
      { tag: 'markdown', content: visible },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: active ? '展开本轮完整进度' : '展开本轮回复' } },
        elements: [{ tag: 'markdown', content: bounded(response, active ? 4000 : 2500) }] },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '系统信息详情' } },
        elements: [{ tag: 'markdown', content: bounded(lines(systems) || '暂无系统信息。', 1200) }] },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: `工具调用详情 · 最近 ${tools.length} 条` } },
        elements: [{ tag: 'markdown', content: bounded(lines(tools) || '暂无工具调用。', 1800) }] },
      ...actions,
      { tag: 'markdown', content: `运行：${run.id}\n会话结束不代表 Slice 验收通过；路线进度回到父话题。` },
    ] } };
}
