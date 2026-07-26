import crypto from 'node:crypto';
import { AESCipher } from '@larksuiteoapi/node-sdk';
import {
  parseFeishuMessageContent,
  type ParsedFeishuMessage,
} from '@/lib/feishu-message-content';

type FeishuMessageMention = {
  id?: {
    open_id?: string;
  };
  key?: string;
  name?: string;
};

type FeishuIncomingEvent = {
  schema?: string;
  token?: string;
  type?: string;
  challenge?: string;
  encrypt?: string;
  header?: {
    event_type?: string;
    token?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
    message?: {
      chat_id?: string;
      chat_type?: string;
      message_id?: string;
      message_type?: string;
      content?: string;
      mentions?: FeishuMessageMention[];
    };
  };
};

type FeishuWebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function getHeaderValue(
  headers: FeishuWebhookHeaders,
  name: string
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) || undefined;
  }

  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function decryptFeishuPayload(encryptedContent: string, encryptKey: string): FeishuIncomingEvent {
  const decrypted = new AESCipher(encryptKey).decrypt(encryptedContent);
  return JSON.parse(decrypted) as FeishuIncomingEvent;
}

export function validateFeishuRequestSignature(args: {
  payload: unknown;
  headers: FeishuWebhookHeaders;
}): boolean {
  const encryptKey = getOptionalEnv('FEISHU_ENCRYPT_KEY');
  if (!encryptKey) {
    return true;
  }

  const payload =
    args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? (args.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return false;
  }

  const timestamp = getHeaderValue(args.headers, 'x-lark-request-timestamp');
  const nonce = getHeaderValue(args.headers, 'x-lark-request-nonce');
  const signature = getHeaderValue(args.headers, 'x-lark-signature');
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computedSignature = crypto
    .createHash('sha256')
    .update(timestamp + nonce + encryptKey + JSON.stringify(payload))
    .digest('hex');

  return computedSignature === signature;
}

export function normalizeFeishuPayload(payload: FeishuIncomingEvent): FeishuIncomingEvent {
  if (!payload.encrypt) {
    return payload;
  }

  const encryptKey = getRequiredEnv('FEISHU_ENCRYPT_KEY');
  return decryptFeishuPayload(payload.encrypt, encryptKey);
}

export function getFeishuChallengeResponse(
  payload: FeishuIncomingEvent
): { challenge: string } | null {
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return { challenge: payload.challenge };
  }

  return null;
}

export function validateFeishuVerificationToken(payload: FeishuIncomingEvent): boolean {
  const expected = getOptionalEnv('FEISHU_VERIFICATION_TOKEN');
  if (!expected) {
    return true;
  }

  const actual = payload.token || payload.header?.token;
  return actual === expected;
}

export function parseFeishuMessage(payload: FeishuIncomingEvent): ParsedFeishuMessage | null {
  if (payload.type === 'url_verification') {
    return null;
  }

  if (payload.header?.event_type !== 'im.message.receive_v1') {
    return null;
  }

  const message = payload.event?.message;
  const senderOpenId = payload.event?.sender?.sender_id?.open_id;
  if (!message?.chat_id || !message.message_id || !message.content || !senderOpenId) {
    return null;
  }

  const parsedContent = parseFeishuMessageContent(message.message_type, message.content);

  if (!parsedContent?.text) {
    return null;
  }

  return {
    chatId: message.chat_id,
    chatType: message.chat_type || 'group',
    messageId: message.message_id,
    senderOpenId,
    messageType: parsedContent.messageType,
    text: parsedContent.text,
    fileKey: parsedContent.fileKey,
    fileKeys: parsedContent.fileKeys,
    mentions: (message.mentions || [])
      .map((mention) => mention.id?.open_id)
      .filter((value): value is string => !!value),
    mentionNames: (message.mentions || [])
      .map((mention) => mention.name?.trim())
      .filter((value): value is string => !!value),
  };
}
