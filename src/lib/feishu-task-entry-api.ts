import { safeFeishuCard } from './feishu-card-markdown';
import { getFeishuTenantAccessToken } from '@/lib/feishu-api';

// Shapes follow the installed official SDK: im.v1.chat.get/message.get/reply/patch.
async function taskApi(path: string, method = 'GET', body?: Record<string, unknown>) {
  const token = await getFeishuTenantAccessToken();
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.data) {
    throw new Error(result.msg || `Feishu task API failed: HTTP ${response.status}`);
  }
  return result.data;
}

export async function isFeishuGroupAdmin(chatId: string, openId: string) {
  if (!openId) return false;
  const chat = await taskApi(`chats/${encodeURIComponent(chatId)}?user_id_type=open_id`);
  return chat.owner_id === openId || (Array.isArray(chat.user_manager_id_list) && chat.user_manager_id_list.includes(openId));
}

export async function getFeishuTaskThread(args: {
  chatId: string; rootMessageId: string; requestId: string; mayReply: boolean;
}) {
  const path = `messages/${encodeURIComponent(args.rootMessageId)}`;
  const data = await taskApi(path);
  const root = data.items?.find((item: { message_id?: string }) => item.message_id === args.rootMessageId);
  if (!root || root.chat_id !== args.chatId || root.deleted) throw new Error('任务入口消息不属于当前群或已删除');
  if (root.thread_id) return root.thread_id as string;
  if (!args.mayReply) throw new Error('创建请求已超过安全重试窗口，请管理员核对原卡片，勿重复创建');
  const reply = await taskApi(`${path}/reply`, 'POST', {
    msg_type: 'text', content: JSON.stringify({ text: '正在绑定独立任务，待入口卡片显示就绪后在此话题继续。' }),
    reply_in_thread: true, uuid: `${args.requestId}-thread`,
  });
  if (reply.chat_id !== args.chatId || reply.root_id !== args.rootMessageId || !reply.thread_id) {
    throw new Error('飞书未返回可验证的话题归属，任务尚未开放');
  }
  return reply.thread_id as string;
}

export async function updateFeishuTaskEntryCard(messageId: string, card: Record<string, unknown>) {
  await taskApi(`messages/${encodeURIComponent(messageId)}`, 'PATCH', { content: JSON.stringify(safeFeishuCard(card)) });
}
