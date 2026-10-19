import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { FeishuApiError, sendFeishuMarkdownFile } from '../feishu-api';

type ArtifactArgs = { parentTaskId: string; chatId: string; appId: string | null;
  rootMessageId: string | null; replyId?: string; path: string; content: Buffer };

export function artifactDeliveryIdentity(args: ArtifactArgs) {
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const key = createHash('sha256').update(JSON.stringify([args.parentTaskId, args.appId, args.chatId,
    args.rootMessageId, args.path, contentHash])).digest('hex');
  return { key, contentHash };
}

/** Reserve before the external write. An uncertain send is never repeated blindly. */
export async function deliverGraphArtifact(args: ArtifactArgs) {
  return deliverGraphArtifactUsing(args, key => sendFeishuMarkdownFile({ chatId: args.chatId,
    fileName: args.path.split('/').pop()!, content: args.content,
    replyId: args.replyId || args.rootMessageId || undefined, replyInThread: !!args.rootMessageId,
    uuid: key.slice(0, 50) }));
}

export async function deliverGraphArtifactUsing(args: ArtifactArgs, send: (key: string) => Promise<string | undefined>) {
  const { key, contentHash } = artifactDeliveryIdentity(args);
  let reserved = false;
  try {
    await prisma.taskGraphArtifactDelivery.create({ data: { key, contentHash,
      parentTaskId: args.parentTaskId, artifactPath: args.path } });
    reserved = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
  }
  if (!reserved) {
    const previous = await prisma.taskGraphArtifactDelivery.findUniqueOrThrow({ where: { key } });
    if (previous.status === 'sent' && previous.messageId) return previous.messageId;
    if (previous.status !== 'failed') throw new Error(`附件发送中或回执不确定，未重复发送：${args.path}`);
    reserved = (await prisma.taskGraphArtifactDelivery.updateMany({ where: { key, status: 'failed' }, data: { status: 'sending' } })).count === 1;
    if (!reserved) throw new Error(`附件正在由另一请求发送：${args.path}`);
  }
  try {
    const messageId = await send(key);
    if (!messageId) throw new Error('飞书附件未返回消息 ID，需核对实际消息后恢复');
    await prisma.taskGraphArtifactDelivery.update({ where: { key }, data: { status: 'sent', messageId } });
    return messageId;
  } catch (error) {
    await prisma.taskGraphArtifactDelivery.update({ where: { key },
      data: { status: error instanceof FeishuApiError && error.code !== 0 ? 'failed' : 'uncertain' } });
    throw error;
  }
}
