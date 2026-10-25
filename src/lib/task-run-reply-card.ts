import { turnReplyElements } from './agent-reply-card';
import { AgentReplyState, parseAgentMessageInfo } from './agent-reply-state';
import { buildLiveRoomFootnotes } from './live-room-footnotes';
import type { TaskRun, TaskRunEvent, TaskRunParticipant, TaskRunInteractionRequest } from '@prisma/client';
import { redactSensitiveText } from './redact-sensitive';
import type { ExecutionProgress } from './task-graph/execution-progress';
import { boundFeishuCardText } from './feishu-card-markdown';

type ReplyRun = Pick<TaskRun, 'id' | 'status' | 'summary' | 'error'> & Partial<Pick<TaskRun, 'startedAt' | 'completedAt'>> & { participants: TaskRunParticipant[]; graphStatus?: string; graphProgress?: ExecutionProgress | null; replyKind?: 'conversation'; graphWorkspace?: { repository: string; executionId: string; branch: string | null; path: string | null } };
const labels: Record<string, string> = { running: '执行中', waiting_for_input: '等待确认', pending: '等待启动', completed: '执行完成', failed: '执行失败', interrupted: '已中断', stopped: '已停止' };
const roles: Record<string, string> = { implementer: '实施者', reviewer: '架构审查', tester: '测试验收' };
const bounded = (content: string, limit: number) => boundFeishuCardText(redactSensitiveText(content), limit);

export function buildRunReplyCard(run: ReplyRun, history: TaskRunEvent[], requests: TaskRunInteractionRequest[] = [], output: (Pick<TaskRunEvent, 'content'> & Partial<Pick<TaskRunEvent, 'sequence' | 'metadata'>>)[] = [], formatReply: (text: string) => string = text => text) {
  const identity = run.participants.map((p) => `${roles[p.role] || p.role} · ${p.harnessNameSnapshot || p.harnessType || p.runner}`).join(' / ');
  const isTool = (event: TaskRunEvent) => {
    try { if (JSON.parse(event.metadata || '{}').kind === 'tool') return true; } catch { /* Legacy events may lack JSON metadata. */ }
    return event.content.startsWith('工具：');
  };
  const lines = (events: TaskRunEvent[]) => events.map(event => `${event.createdAt.toISOString().slice(11, 19)} UTC · ${event.content}`).join('\n\n');
  const tools = history.filter(isTool);
  const systems = history.filter(event => !isTool(event));
  const active = ['running', 'waiting_for_input', 'pending'].includes(run.status);
  const replyState = new AgentReplyState();
  output.forEach((event, index) => {
    let metadata: unknown;
    try { metadata = JSON.parse(event.metadata || '{}').agentMessage; } catch { metadata = undefined; }
    const message = parseAgentMessageInfo(metadata);
    const previous = output[index - 1];
    const boundary = !message && previous?.sequence !== undefined && event.sequence !== undefined && event.sequence > previous.sequence + 1;
    replyState.append((boundary ? '\n\n' : '') + event.content, message);
  });
  const finalReply = run.participants.map(participant => participant.summary || participant.error || '').filter(Boolean).join('\n\n') || run.summary || run.error || '';
  const view = replyState.view(finalReply);
  const progressReply = formatReply(view.process);
  const reply = formatReply(active ? view.latest : view.final);
  const now = run.completedAt?.getTime() || Date.now();
  const footnotes = run.participants.length ? run.participants.flatMap(participant => buildLiveRoomFootnotes({
    participantId: participant.id, metadata: participant.controlMetadata,
    startedAt: run.startedAt?.getTime() || participant.startedAt?.getTime() || now, now,
  })) : ['模型信息未提供 · Token 用量未提供'];
  const errors = Array.from(new Set([run.error, ...run.participants.map(p => p.error)].filter((error): error is string => Boolean(error))));
  const failure = errors.filter(error => !reply.includes(error)).join('\n\n');
  const status = run.status === 'running' && run.participants.some(p => ['tester', 'reviewer'].includes(p.role)) ? '正在复核'
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
    body: { elements: turnReplyElements({ active, latest: reply, final: reply, process: progressReply, tools: lines(tools),
      processEntries: view.processEntries.map(formatReply), processStarted: `${run.status === 'pending' ? '等待启动' : '开始处理消息'} | ${identity || 'Harness'}`,
      footnotes, schema: '2.0',
      notices: [...(failure ? [{ tag: 'markdown', content: bounded(`本轮失败原因：\n${failure}`, 4000) }] : []), ...actions],
      details: [
        ...(run.graphWorkspace ? [{ title: '工作区与保留条件', text: `项目：${run.graphWorkspace.repository}\nTicket 执行：${run.graphWorkspace.executionId}\n分支：${run.graphWorkspace.branch || '未绑定'}\n实际工作区：${run.graphWorkspace.path || '未创建'}\nSession、Writer 或绝对路径引用未核实释放时保持现场。只读清单见 workspace:inventory。`, limit: 2400 }] : []),
        { title: '运行记录', text: `运行：${run.id}\n${lines(systems) || '暂无系统事件。'}\n完整过程与工具记录保留在平台任务运行日志。`, limit: 1200 },
      ],
    }) } };
}
