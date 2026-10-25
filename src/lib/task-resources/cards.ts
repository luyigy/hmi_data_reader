import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { resolveFeishuMessageTarget, sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import { updateFeishuTaskEntryCard } from '@/lib/feishu-task-entry-api';
import { prisma } from '@/lib/prisma';
import { decideResourceAccess, getResourceApproval, recordResourceDelivery } from './access';
import type { ResourceApproval, ResourceInput } from './model';
import { reconcileResourceApprovals } from './reconcile';
import { resourceTaskBinding } from './delivery';
import { retryResourceApplication } from './retry';
import { boundFeishuCardText } from '../feishu-card-markdown';
import { redactSensitiveText } from '../redact-sensitive';

const label = (content: string) => ({ tag: 'plain_text', content });
const clean = (content: string) => content.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
const button = (action: string, approval: ResourceApproval, title: string, type: string) => ({
  tag: 'button', type, text: label(title),
  value: { cmd: `resource-approval:${action}:${approval.id}:${approval.payload.revision}` },
});

function applicationText(approval: ResourceApproval) {
  const { state, detail, runId } = approval.payload.application;
  if (approval.status === 'pending') return '等待管理员决定；目录尚未挂载。';
  if (approval.status === 'denied') return '申请已拒绝；目录未挂载。';
  if (approval.status === 'expired') return '申请已过期；目录未挂载。';
  if (approval.status === 'revoked') return state === 'revoked' ? '授权已撤销，运行中的使用已停止。' : '已请求撤销，正在停止使用该授权的运行。';
  const message: Record<string, string> = {
    waiting: detail ? `已批准，准备或接续暂未完成：${clean(detail)}` : '已批准，等待当前执行安全停止。',
    scheduled: '已批准，正在准备目录并安排原会话接续。',
    effective: detail ? clean(detail) : '目录已生效，已接续原会话。',
    failed: `已批准，但准备失败：${clean(detail || '请查看执行记录')}`,
    revoking: '正在停止使用该授权的运行。',
    revoked: '授权已撤销，运行中的使用已停止。',
  };
  return `${message[state] || '等待应用结果。'}${runId ? `\n接续运行：\`${clean(runId)}\`` : ''}`;
}

export function buildResourceApprovalCard(approval: ResourceApproval, editing = false): object {
  const { payload } = approval;
  const pending = approval.status === 'pending';
  const project = payload.projectPath ? `\n项目身份：\`${clean(payload.projectPath)}\`` : '';
  const lines = payload.resources.map((resource, index) =>
    `${index + 1}. ${resource.access === 'write' ? '读写' : '只读'} \`${clean(resource.canonicalPath)}\`（申请路径 \`${clean(resource.path)}\`）`);
  const purpose = clean(payload.purpose);
  const task = clean(payload.launch.taskId);
  const participant = payload.launch.participants[0];
  const executor = participant
    ? `${clean(participant.agentName || participant.agentId || participant.harnessType)} · ${clean(participant.role)} · ${clean(participant.executionBackend)} / ${clean(participant.gatewayId)}`
    : '未指定';
  return {
    config: { wide_screen_mode: true },
    header: { template: pending ? 'orange' : approval.status === 'approved' ? 'green' : 'grey',
      title: label(`补充资源授权 · ${{ pending: '待决定', approved: '已批准', denied: '已拒绝', expired: '已过期', revoked: '撤销中或已撤销' }[approval.status] || approval.status}`) },
    elements: [
      { tag: 'markdown', content: `任务：\`${task}\`\n执行者：${executor}\n用途：${purpose}\n申请人：\`${clean(approval.requesterOpenId)}\`\n范围：${payload.scope === 'task' ? '当前任务，后续会话沿用' : '同项目任务复用'}${project}\n版本：${payload.revision}\n\n${lines.join('\n')}\n\n${applicationText(approval)}` },
      ...(payload.launch.graphExecution && payload.resources.some(resource => resource.access === 'write') ? [{ tag: 'markdown', content: '批准后允许本实施会话编辑列出的补充目录；已有只读子目录（如依赖环境）保持只读。补充仓的修改需单独提交和验证，当前票的固定输入、验收条件与其他任务工作区保持原有约束。' }] : []),
      ...(pending && !editing ? [{ tag: 'action', actions: [
        button('approve', approval, '批准并继续', 'primary'),
        button('edit', approval, '调整范围', 'default'),
        button('deny', approval, '拒绝', 'danger'),
      ] }] : []),
      ...(pending && editing ? [{
        tag: 'form', name: `resource-edit-${approval.id}`, elements: [
          { tag: 'markdown', content: '逐项选择保留的权限。移除目录或把读写改成只读后，将生成新版本预览；不会直接批准。' },
          ...payload.resources.map((resource, index) => ({
            tag: 'select_static', name: `resource_${index}`, required: true, width: 'fill',
            placeholder: label(`${index + 1}. ${resource.path}`),
            initial_option: resource.access,
            options: [
              { text: label('移除'), value: 'remove' },
              { text: label('只读'), value: 'read' },
              ...(resource.access === 'write' ? [{ text: label('读写'), value: 'write' }] : []),
            ],
          })),
          { tag: 'select_static', name: 'resource_scope', required: true, width: 'fill',
            placeholder: label('有效范围'), initial_option: payload.scope,
            options: [
              { text: label('当前任务'), value: 'task' },
              ...(payload.projectPath && payload.ownerKey.startsWith('user:') ? [{ text: label(`同项目复用 · ${payload.projectPath}`), value: 'project' }] : []),
            ] },
          { ...button('replace', approval, '生成新版预览', 'primary'), name: 'replaceResourceApproval', action_type: 'form_submit' },
        ],
      }] : []),
      ...(approval.status === 'approved' ? [{ tag: 'action', actions: [
        ...(payload.application.state === 'failed' && !payload.launch.graphConversation &&
          (!(payload.launch.graphExecution || payload.launch.graphReview) || !payload.application.runId && !payload.application.eventId)
          ? [button('retry', approval, '重试准备与接续', 'primary')] : []),
        button('revoke', approval, '撤销授权', 'danger')] }] : []),
    ],
  };
}

async function taskTarget(approval: ResourceApproval) {
  const binding = await resourceTaskBinding(approval.payload.launch.taskId);
  return binding ? resolveFeishuMessageTarget(binding) : approval.requesterChatId ? {
    receiveId: approval.requesterChatId, receiveIdType: 'chat_id' as const,
  } : { receiveId: process.env.FEISHU_ADMIN_OPEN_ID!.trim(), receiveIdType: 'open_id' as const };
}

export async function publishResourceApproval(id: string): Promise<void> {
  const approval = await getResourceApproval(id);
  const admin = process.env.FEISHU_ADMIN_OPEN_ID?.trim();
  if (!admin) throw new Error('Missing required environment variable: FEISHU_ADMIN_OPEN_ID');
  const card = buildResourceApprovalCard(approval) as { elements: object[] };
  if (approval.payload.application.runId && !approval.payload.launch.graphExecution && !approval.payload.launch.graphReview) {
    const run = await prisma.taskRun.findUnique({ where: { id: approval.payload.application.runId }, include: { participants: true } });
    const reply = run?.participants.map(p => p.summary || p.error).filter(Boolean).join('\n\n') || run?.summary;
    if (reply) card.elements.push({ tag: 'markdown', content: boundFeishuCardText(redactSensitiveText(reply), 12000) });
  }
  const target = await taskTarget(approval);
  if (approval.cardMessageId) {
    await updateFeishuTaskEntryCard(approval.cardMessageId, card);
  } else {
    const messageId = await sendFeishuInteractiveMessage({ ...target, card, uuid: `resource-approval-${id}-task` });
    if (!messageId) throw new Error('Feishu did not return a resource approval card message ID');
    const saved = await prisma.feishuAdminApproval.updateMany({
      where: { id, cardMessageId: null }, data: { cardMessageId: messageId },
    });
    if (!saved.count) {
      const current = await getResourceApproval(id);
      if (current.cardMessageId !== messageId) throw new Error('Resource approval card identity changed during publication');
    }
  }
  if (approval.payload.delivery?.adminMessageId) {
    await updateFeishuTaskEntryCard(approval.payload.delivery.adminMessageId, card);
  } else if (approval.status === 'pending' && approval.requesterOpenId !== admin && !(target.receiveIdType === 'open_id' && target.receiveId === admin)) {
    const adminMessageId = await sendFeishuInteractiveMessage({ receiveId: admin, receiveIdType: 'open_id', card,
      uuid: `resource-approval-${id}-admin` });
    if (!adminMessageId) throw new Error('Feishu did not return an administrator card message ID');
    await recordResourceDelivery(id, { adminMessageId });
  }
}

function selected(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') return value.value;
  return undefined;
}

async function updateVisibleCards(approval: ResourceApproval, clickedMessageId?: string) {
  const card = buildResourceApprovalCard(approval) as Record<string, unknown>;
  const ids = new Set([approval.cardMessageId, approval.payload.delivery?.adminMessageId, clickedMessageId].filter((id): id is string => !!id));
  await Promise.all(Array.from(ids).map(id => updateFeishuTaskEntryCard(id, card)));
}

export async function handleResourceApprovalAction(args: {
  cmd: string; value?: Record<string, unknown>; formValue?: Record<string, unknown>;
  openId?: string; messageId?: string; chatId?: string;
}): Promise<{ toast: { type: string; content: string } } | null> {
  const match = /^resource-approval:(approve|deny|edit|replace|revoke|retry):([^:]+):(\d+)$/.exec(args.cmd);
  if (!match) return null;
  const [, action, id, rawRevision] = match;
  if (!isFeishuAdmin(args.openId)) return { toast: { type: 'warning', content: '仅配置的飞书管理员可以决定宿主目录授权。' } };
  try {
    const approval = await getResourceApproval(id);
    const revision = Number(rawRevision);
    if (!Number.isSafeInteger(revision) || revision !== approval.payload.revision) throw new Error('卡片版本已失效，请查看最新申请。');
    if (action === 'edit') {
      if (approval.status !== 'pending' || !args.messageId) throw new Error('申请已失效或卡片消息缺失。');
      await updateFeishuTaskEntryCard(args.messageId, buildResourceApprovalCard(approval, true) as Record<string, unknown>);
      return { toast: { type: 'success', content: '请逐项调整，再生成新版预览。' } };
    }
    let resources: ResourceInput[] | undefined;
    let scope: 'task' | 'project' | undefined;
    if (action === 'replace') {
      if (approval.status !== 'pending') throw new Error('申请已失效。');
      resources = approval.payload.resources.flatMap((resource, index) => {
        const access = selected(args.formValue?.[`resource_${index}`]);
        if (access === 'remove') return [];
        if (access !== 'read' && access !== resource.access) throw new Error('调整范围只能移除目录或降低为只读。');
        return [{ path: resource.path, access }];
      });
      if (!resources?.length) throw new Error('请至少保留一个目录。');
      const requestedScope = selected(args.formValue?.resource_scope);
      if (requestedScope !== 'task' && requestedScope !== 'project') throw new Error('请选择有效范围。');
      if (requestedScope === 'project' && !approval.payload.projectPath) throw new Error('缺少明确的项目身份，不能授予项目范围。');
      scope = requestedScope;
    }
    const changed = action === 'retry' ? await retryResourceApplication(id, revision, args.openId!) : await decideResourceAccess({ id, revision, actorOpenId: args.openId!,
      action: action as 'approve' | 'deny' | 'replace' | 'revoke', resources, scope });
    // Graph preparation belongs to the coordinator, including its host capacity configuration.
    if (action === 'revoke' || (action === 'approve' || action === 'retry') &&
        !changed.payload.launch.graphExecution && !changed.payload.launch.graphReview && !changed.payload.launch.graphConversation) {
      void reconcileResourceApprovals(id).catch((error: unknown) => console.error('Resource approval reconciliation failed', { id, error }));
    }
    await updateVisibleCards(changed, args.messageId);
    if (action === 'replace') await publishResourceApproval(id);
    const message: Record<string, string> = {
      retry: '正在复用原批准重试准备与接续。',
      approve: '授权决定已记录，平台正在准备目录并接续原任务。',
      deny: '申请已拒绝。', replace: '新版范围已生成，请核对后再批准。', revoke: '撤销决定已记录，平台正在停止相关运行。',
    };
    return { toast: { type: 'success', content: message[action] } };
  } catch (error) {
    return { toast: { type: 'warning', content: error instanceof Error ? error.message : '卡片处理失败。' } };
  }
}
