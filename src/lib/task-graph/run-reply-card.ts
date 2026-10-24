import type { TaskRun, TaskRunEvent, TaskRunParticipant, TaskRunInteractionRequest } from '@prisma/client';
import { redactSensitiveText } from '../redact-sensitive';
import type { ExecutionProgress } from './execution-progress';
import { boundFeishuCardText } from '../feishu-card-markdown';

type ReplyRun = Pick<TaskRun, 'id' | 'status' | 'summary' | 'error'> & { participants: TaskRunParticipant[]; graphStatus?: string; graphProgress?: ExecutionProgress | null; replyKind?: 'conversation'; graphWorkspace?: { repository: string; executionId: string; branch: string | null; path: string | null } };
const labels: Record<string, string> = { running: '执行中', waiting_for_input: '等待确认', pending: '等待启动', completed: '本轮已结束', failed: '执行失败', interrupted: '已中断', stopped: '已停止' };
const roles: Record<string, string> = { implementer: '实施者', reviewer: '架构审查', tester: '测试验收' };
const bounded = (content: string, limit: number) => boundFeishuCardText(redactSensitiveText(content), limit);

function agentReply(response: string) {
  const control = /^TASK_GRAPH_(?:IMPLEMENTATION|CONVERSATION|REVIEW)\s+(\{[^\n]+\})\s*$/gm;
  const parts = [response.replace(control, '').trim()];
  for (const block of Array.from(response.matchAll(control))) {
    try {
      const value: unknown = JSON.parse(block[1]);
      if (value && typeof value === 'object' && 'note' in value && typeof value.note === 'string' &&
        value.note.trim()) {
        const note = value.note.trim();
        if (!parts.some(part => part.includes(note))) parts.push(note);
      }
    } catch { /* Invalid controls are handled by the execution protocol, not card rendering. */ }
  }
  return parts.filter(Boolean).join('\n\n');
}

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
  const conversation = run.replyKind === 'conversation';
  const streamed = output.map(event => event.content).join('');
  const finalReply = run.participants.map(participant => participant.summary || participant.error || '').filter(Boolean).join('\n\n') || run.summary || run.error || streamed;
  const progressReply = agentReply(streamed);
  const finalResponse = active ? '' : agentReply(finalReply);
  // A final summary may contain only the last answer; it must not replace earlier speech.
  const reply = !finalResponse ? progressReply
    : !progressReply || finalResponse.includes(progressReply) ? finalResponse
    : progressReply.endsWith(finalResponse) ? [progressReply.slice(0, -finalResponse.length).trimEnd(), finalResponse].filter(Boolean).join('\n\n')
    : progressReply.includes(finalResponse) ? progressReply
    : `${progressReply}\n\n${finalResponse}`;
  const response = reply || (active ? '正在准备执行，尚无 Agent 回复。' : '本轮没有文字答复。');
  const errors = Array.from(new Set([run.error, ...run.participants.map(p => p.error)].filter((error): error is string => Boolean(error))));
  const failure = errors.filter(error => !reply.includes(error)).join('\n\n');
  const status = conversation && run.status === 'completed' ? '本轮已答复'
    : run.status === 'running' && run.participants.some(p => ['tester', 'reviewer'].includes(p.role)) ? '正在复核'
    : labels[run.status] || run.status;
  const actions = (active ? requests : []).filter((request) => request.status === 'pending' && (!request.expiresAt || request.expiresAt.getTime() > Date.now()))
    .flatMap((request) => {
      let payload: unknown;
      try { payload = JSON.parse(request.rawPayload || '{}'); } catch { payload = null; }
      const supported = payload && typeof payload === 'object' && 'approvalSupported' in payload && payload.approvalSupported === true;
      if (request.requestKind !== 'permission_request') return [{ tag: 'markdown', content: bounded(request.message, 3000) }];
      return [
        { tag: 'markdown', content: bounded(`待确认：${request.message}`, 1000) },
        ...(['deny', ...(supported ? ['approve'] : [])]).map((decision) => ({ tag: 'button', type: decision === 'approve' ? 'primary_filled' : 'default',
          text: { tag: 'plain_text', content: decision === 'approve' ? '仅批准本次操作' : '拒绝' },
          behaviors: [{ type: 'callback', value: { cmd: `${decision}:${request.id}` } }] })),
      ];
    });
  return { schema: '2.0', config: { update_multi: true },
    header: { template: run.status === 'failed' ? 'red' : run.status === 'waiting_for_input' ? 'yellow' : active ? 'blue' : 'grey',
      title: { tag: 'plain_text', content: `${identity || 'Harness'} · ${status}` } },
    body: { elements: [
      { tag: 'markdown', content: boundFeishuCardText(redactSensitiveText(response), 18_000, 'end') },
      ...(failure ? [{ tag: 'markdown', content: bounded(`本轮失败原因：\n${failure}`, 4000) }] : []),
      ...actions,
      ...(run.graphWorkspace ? [{ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '工作区与保留条件' } },
        elements: [{ tag: 'markdown', content: bounded(`项目：${run.graphWorkspace.repository}\nTicket 执行：${run.graphWorkspace.executionId}\n分支：${run.graphWorkspace.branch || '未绑定'}\n实际工作区：${run.graphWorkspace.path || '未创建'}\nSession、Writer 或绝对路径引用未核实释放时保持现场。只读清单见 workspace:inventory。`, 2400) }] }] : []),
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '系统信息详情' } },
        elements: [{ tag: 'markdown', content: bounded(`运行：${run.id}\n${lines(systems) || '暂无系统信息。'}`, 1200) }] },
      { tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: `工具调用详情 · 最近 ${tools.length} 条` } },
        elements: [{ tag: 'markdown', content: bounded(lines(tools) || '暂无工具调用。', 1800) }] },
    ] } };
}
