import { getFeishuTenantAccessToken, replyFeishuMessage } from '../feishu-api';
import { deliverGraphArtifactUsing } from '../task-graph/artifact-delivery';
import { readAuthorizedImage } from './image-file';
import { object } from './policy';

export async function deliverTaskImage(args: { taskId: string; taskRunId: string; path: string; roots: string[];
  target: { appId: string | null; chatId: string; rootMessageId: string | null; threadId: string | null } }) {
  if (args.target.appId !== process.env.FEISHU_APP_ID || !args.target.rootMessageId || !args.target.threadId) throw new Error('图片未绑定当前应用的明确任务话题');
  const image = await readAuthorizedImage(args.path, args.roots);
  return deliverGraphArtifactUsing({ parentTaskId: args.taskId, chatId: args.target.chatId, appId: args.target.appId,
    rootMessageId: args.target.rootMessageId, path: args.taskRunId + ':' + image.canonical, content: image.content }, async key => {
    const token = await getFeishuTenantAccessToken();
    const form = new FormData();
    form.set('image_type', 'message'); form.set('image', new Blob([new Uint8Array(image.content)], { type: image.mime }), 'task-image.' + image.extension);
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/images', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    const uploaded = object(await response.json()), data = object(uploaded.data);
    if (!response.ok || uploaded.code !== 0 || typeof data.image_key !== 'string') throw new Error('图片上传失败，文字答复仍保留');
    const id = await replyFeishuMessage({ messageId: args.target.rootMessageId!, msgType: 'image', content: { image_key: data.image_key }, replyInThread: true, uuid: key.slice(0, 50) });
    if (!id) throw new Error('图片发送回执不确定，不能盲目重发');
    const read = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const result = object(await read.json()), messages = object(result.data);
    if (!read.ok || result.code !== 0 || !Array.isArray(messages.items)) throw new Error('图片已发送，但回读未确认；请核对后处理');
    const item = messages.items.map(object).find(message => message.message_id === id);
    if (!item || item.deleted || item.chat_id !== args.target.chatId || item.thread_id !== args.target.threadId || item.msg_type !== 'image' ||
      object(JSON.parse(String(object(item.body).content))).image_key !== data.image_key) throw new Error('图片已发送，但内容或话题回读不匹配；未重复发送');
    return id;
  });
}
