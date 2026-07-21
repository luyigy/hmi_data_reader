import { downloadFeishuMessageResource } from '@/lib/feishu-api';
import { extractFeishuPostContent } from '@/lib/feishu-post-text';

export type ParsedFeishuMessage = {
  chatId: string;
  chatType: string;
  messageId: string;
  senderOpenId: string;
  messageType: string;
  text: string;
  fileKey?: string | null;
  fileKeys?: string[];
  mentions: string[];
  mentionNames: string[];
};

export function parseFeishuMessageContent(
  messageType: string | undefined,
  rawContent: string
): { text: string | null; messageType: string; fileKey?: string | null; fileKeys?: string[] } | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }

  const normalizedType = (messageType || 'text').trim().toLowerCase();
  if (normalizedType === 'text') {
    const text = typeof content.text === 'string' ? content.text.trim() : '';
    return { text: text || null, messageType: normalizedType };
  }

  if (normalizedType === 'image') {
    const imageKey = typeof content.image_key === 'string' ? content.image_key.trim() : '';
    return {
      text: imageKey ? `[图片消息] image_key=${imageKey}` : '[图片消息]',
      messageType: normalizedType,
      fileKey: imageKey || null,
    };
  }

  if (normalizedType === 'file') {
    const fileKey = typeof content.file_key === 'string' ? content.file_key.trim() : '';
    const fileName = typeof content.file_name === 'string' ? content.file_name.trim() : '';
    const suffix = [fileName, fileKey ? `file_key=${fileKey}` : ''].filter(Boolean).join(' ');
    return {
      text: suffix ? `[文件消息] ${suffix}` : '[文件消息]',
      messageType: normalizedType,
      fileKey: fileKey || null,
    };
  }

  if (normalizedType === 'post') {
    const { text, imageKeys } = extractFeishuPostContent(content);
    return {
      text: text || '[富文本消息]',
      messageType: normalizedType,
      fileKeys: imageKeys,
    };
  }

  if (normalizedType === 'audio') {
    const fileKey = typeof content.file_key === 'string' ? content.file_key.trim() : '';
    return { text: '[语音消息]', messageType: normalizedType, fileKey: fileKey || null };
  }

  if (normalizedType === 'media') {
    const fileKey = typeof content.file_key === 'string' ? content.file_key.trim() : '';
    return { text: '[视频消息]', messageType: normalizedType, fileKey: fileKey || null };
  }

  if (normalizedType === 'sticker') {
    return { text: '[表情消息]', messageType: normalizedType };
  }

  return { text: `[${normalizedType} 消息]`, messageType: normalizedType };
}

export async function hydrateFeishuMessageResources(
  message: ParsedFeishuMessage
): Promise<ParsedFeishuMessage> {
  if (message.fileKeys?.length) {
    const details = await Promise.all(message.fileKeys.map(async (fileKey) => {
      try {
        const downloaded = await downloadFeishuMessageResource({
          messageId: message.messageId,
          fileKey,
          type: 'image',
        });
        return [
          `image_key=${fileKey}`,
          `local_path=${downloaded.filePath}`,
          downloaded.contentType ? `content_type=${downloaded.contentType}` : '',
          `size_bytes=${downloaded.sizeBytes}`,
        ].filter(Boolean).join(' ');
      } catch (error) {
        return `image_key=${fileKey} [资源下载失败: ${error instanceof Error ? error.message : 'unknown error'}]`;
      }
    }));
    return { ...message, text: [message.text, ...details].join('\n') };
  }

  const type = message.messageType === 'media'
    ? 'media'
    : message.messageType as 'image' | 'file' | 'audio';
  if (!message.fileKey || !['image', 'file', 'audio', 'media'].includes(message.messageType)) {
    return message;
  }

  try {
    const downloaded = await downloadFeishuMessageResource({
      messageId: message.messageId,
      fileKey: message.fileKey,
      type,
    });
    return {
      ...message,
      text: [
        message.text,
        `local_path=${downloaded.filePath}`,
        downloaded.contentType ? `content_type=${downloaded.contentType}` : '',
        `size_bytes=${downloaded.sizeBytes}`,
      ].filter(Boolean).join(' '),
    };
  } catch (error) {
    return {
      ...message,
      text: `${message.text} [资源下载失败: ${error instanceof Error ? error.message : 'unknown error'}]`,
    };
  }
}
