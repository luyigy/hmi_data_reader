import type { TaskRun, TaskRunEvent, TaskRunParticipant, TaskRunInteractionRequest } from '@prisma/client';
import { redactSensitiveText } from '../redact-sensitive';

type ReplyRun = Pick<TaskRun, 'id' | 'status' | 'summary' | 'error'> & { participants: TaskRunParticipant[] };
const labels: Record<string, string> = { running: '执行中', waiting_for_input: '等待确认', completed: '会话结束', failed: '执行失败', interrupted: '已中断', stopped: '已停止' };
const roles: Record<string, string> = { implementer: '实施者', reviewer: '架构审查', tester: '测试验收' };
const bounded = (content: string, limit: number) => {
  const safe = redactSensitiveText(content);
  return safe.length > limit ? `…（前文已省略，以下为最近输出）\n${safe.slice(-limit)}` : safe;
};

export function buildRunReplyCard(run: ReplyRun, history: TaskRunEvent[], requests: TaskRunInteractionRequest[] = []) {
  const identity = run.participants.map((p) => `${roles[p.role] || p.role} · ${p.harnessNameSnapshot || p.harnessType || p.runner}`).join(' / ');
  const isTool = (event: TaskRunEvent) => {
    try { if (JSON.parse(event.metadata || '{}').kind === 'tool') return true; } catch { /* Legacy events may lack JSON metadata. */ }
    return event.content.startsWith('工具：');
  };
  const lines = (events: TaskRunEvent[]) => events.map(event => `${event.createdAt.toISOString().slice(11, 19)} UTC · ${event.content}`).join('\n\n');
  const tools = history.filter(isTool);
  const systems = history.filter(event => !isTool(event));
  const active = ['running', 'waiting_for_input', 'pending'].includes(run.status);
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
    header: { template: run.status === 'failed' ? 'red' : run.status === 'waiting_for_input' ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: `${identity || 'Harness'} · ${labels[run.status] || run.status}` } },
    body: { elements: [
      { tag: 'markdown', content: active ? 'Agent 回复单独显示在本话题。' : '本轮会话已结束，结果见 Agent 回复。' },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '系统信息详情' } },
        elements: [{ tag: 'markdown', content: bounded(lines(systems) || '暂无系统信息。', 3000) }] },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: `工具调用详情 · 最近 ${tools.length} 条` } },
        elements: [{ tag: 'markdown', content: bounded(lines(tools) || '暂无工具调用。', 4500) }] },
      ...actions,
      { tag: 'markdown', content: `运行：${run.id}\n会话结束不代表 Slice 验收通过；路线进度回到父话题。` },
    ] } };
}

/** Agent text has its own message; technical events remain on the progress card. */
export function buildRunAgentReplyCard(identity: string, content: string) {
  return { schema: '2.0', config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: identity } },
    body: { elements: [{ tag: 'markdown', content: bounded(content, 10_000) }] },
  };
}
