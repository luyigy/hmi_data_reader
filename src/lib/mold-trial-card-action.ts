import { createHmac } from 'node:crypto';


export async function forwardMoldTrialCardAction(args: {
  openId?: string;
  value: Record<string, unknown>;
  formValue?: Record<string, unknown>;
}) {
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appSecret || !args.openId) {
    return { toast: { type: 'warning', content: '科学试模审批身份配置无效' } };
  }
  const body = JSON.stringify({
    header: { event_type: 'card.action.trigger' },
    event: {
      operator: { operator_id: { open_id: args.openId } },
      action: { value: args.value, form_value: args.formValue || {} },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', appSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  try {
    const response = await fetch(
      'http://127.0.0.1:8010/api/integrations/feishu/trial-approval/internal-action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mold-Request-Timestamp': timestamp,
          'X-Mold-Signature': signature,
        },
        body,
        signal: AbortSignal.timeout(2500),
      },
    );
    const result = await response.json() as Record<string, unknown>;
    if (response.ok) return result;
    const detail = typeof result.detail === 'string' ? result.detail : '科学试模审批失败';
    return { toast: { type: 'warning', content: detail } };
  } catch {
    return { toast: { type: 'warning', content: '科学试模审批服务暂不可用' } };
  }
}
