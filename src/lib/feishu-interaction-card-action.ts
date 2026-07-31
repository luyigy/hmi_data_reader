import { resolveInteractionRequestWithContinuation } from '@/lib/acpx/interaction-actions';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { updateFeishuApprovalCardResolved } from '@/lib/feishu-api';
import { prisma } from '@/lib/prisma';

export async function handleFeishuInteractionCardAction(args: {
  cmd: string;
  formValue?: Record<string, unknown>;
  openId?: string;
  messageId?: string;
  actorName: string;
  prefix: string;
}) {
  const match = /^(approve|deny|answer):(.+)$/.exec(args.cmd);
  if (!match) return null;
  if (!isFeishuAdmin(args.openId)) {
    const access = args.openId
      ? await prisma.feishuUserAccess.findUnique({
          where: { openId: args.openId },
          select: { status: true },
        })
      : null;
    if (access?.status !== 'approved') return {};
  }

  const action = match[1] as 'approve' | 'deny' | 'answer';
  const requestId = match[2];
  const responseText = typeof args.formValue?.responseText === 'string'
    ? args.formValue.responseText.trim()
    : '';
  if (action === 'answer' && !responseText) {
    return { toast: { type: 'warning', content: '请填写确认内容或选择结果' } };
  }

  try {
    await resolveInteractionRequestWithContinuation({
      requestId,
      action,
      responseText: responseText || undefined,
      actor: {
        id: args.openId || 'feishu_card',
        name: args.actorName,
        channel: 'feishu',
      },
    });
    if (args.messageId) {
      await updateFeishuApprovalCardResolved({
        messageId: args.messageId,
        approved: action !== 'deny',
        actorName: args.actorName,
      }).catch(() => undefined);
    }
    console.log(`${args.prefix} interaction card resolved`, { requestId, action });
    return { toast: { type: 'success', content: action === 'answer' ? '输入已提交' : '确认已处理' } };
  } catch (error) {
    console.error(`${args.prefix} interaction card resolution failed`, { requestId, error });
    return {
      toast: {
        type: 'warning',
        content: error instanceof Error ? error.message : '确认卡已失效',
      },
    };
  }
}
