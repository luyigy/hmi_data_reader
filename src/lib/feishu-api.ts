import path from 'node:path';
import { promises as fs } from 'node:fs';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

type FeishuReactionResponse = {
  code: number;
  msg?: string;
  data?: {
    reaction_id?: string;
  };
};

type FeishuTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

type FeishuSendMessageResponse = {
  code: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

type FeishuMessageResourceDownloadResult = {
  filePath: string;
  contentType: string | null;
  sizeBytes: number;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getFeishuTenantAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const response = await fetch(
    `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: getRequiredEnv('FEISHU_APP_ID'),
        app_secret: getRequiredEnv('FEISHU_APP_SECRET'),
      }),
    }
  );

  const data = (await response.json()) as FeishuTokenResponse;
  if (!response.ok || data.code !== 0 || !data.tenant_access_token || !data.expire) {
    throw new Error(data.msg || `Failed to get Feishu tenant access token: HTTP ${response.status}`);
  }

  cachedToken = {
    value: data.tenant_access_token,
    expiresAt: Date.now() + Math.max(data.expire - 120, 60) * 1000,
  };

  return cachedToken.value;
}

export async function sendFeishuTextMessage(args: {
  receiveId: string;
  text: string;
  receiveIdType?: 'chat_id' | 'open_id';
  replyId?: string;
}) {
  const token = await getFeishuTenantAccessToken();
  const receiveIdType = args.receiveIdType || 'chat_id';
  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set('receive_id_type', receiveIdType);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: args.receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: args.text }),
      ...(args.replyId ? { reply_id: args.replyId } : {}),
    }),
  });

  const data = (await response.json()) as FeishuSendMessageResponse;
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Failed to send Feishu message: HTTP ${response.status}`);
  }
}

export async function sendFeishuInteractiveMessage(args: {
  receiveId: string;
  card: Record<string, unknown>;
  receiveIdType?: 'chat_id' | 'open_id';
  replyId?: string;
}) {
  const token = await getFeishuTenantAccessToken();
  const receiveIdType = args.receiveIdType || 'chat_id';
  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set('receive_id_type', receiveIdType);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: args.receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(args.card),
      ...(args.replyId ? { reply_id: args.replyId } : {}),
    }),
  });

  const data = (await response.json()) as FeishuSendMessageResponse;
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Failed to send Feishu interactive message: HTTP ${response.status}`);
  }
}

function guessFileExtension(contentType: string | null, fallbackType: string) {
  const normalized = (contentType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('heic')) return 'heic';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('mpeg')) return 'mpeg';
  if (normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  return fallbackType === 'image' ? 'bin' : fallbackType;
}

export async function downloadFeishuMessageResource(args: {
  messageId: string;
  fileKey: string;
  type: 'image' | 'file' | 'audio' | 'video' | 'media';
}): Promise<FeishuMessageResourceDownloadResult> {
  const token = await getFeishuTenantAccessToken();
  const url = new URL(
    `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(args.messageId)}/resources/${encodeURIComponent(args.fileKey)}`
  );
  url.searchParams.set('type', args.type === 'media' ? 'video' : args.type);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      errorText || `Failed to download Feishu message resource: HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type');
  const ext = guessFileExtension(contentType, args.type);
  const dir = path.join(process.cwd(), '.runtime', 'feishu-message-resources');
  await fs.mkdir(dir, { recursive: true });

  const safeFileKey = args.fileKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const filePath = path.join(dir, `${args.messageId}_${safeFileKey}.${ext}`);
  await fs.writeFile(filePath, buffer);

  return {
    filePath,
    contentType,
    sizeBytes: buffer.byteLength,
  };
}

// Returns the reaction_id on success, or null if the call fails (non-blocking).
export async function addTypingReaction(messageId: string): Promise<string | null> {
  try {
    const token = await getFeishuTenantAccessToken();
    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reaction_type: { emoji_type: 'Typing' } }),
      }
    );
    const data = (await response.json()) as FeishuReactionResponse;
    return data.data?.reaction_id || null;
  } catch {
    return null;
  }
}

export async function removeTypingReaction(
  messageId: string,
  reactionId: string
): Promise<void> {
  try {
    const token = await getFeishuTenantAccessToken();
    await fetch(
      `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch {
    // silent — typing cleanup is best-effort
  }
}

export async function sendFeishuTextMessageAndReturnId(args: {
  receiveId: string;
  text: string;
  receiveIdType?: 'chat_id' | 'open_id';
}): Promise<string> {
  const token = await getFeishuTenantAccessToken();
  const receiveIdType = args.receiveIdType || 'chat_id';
  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set('receive_id_type', receiveIdType);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: args.receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: args.text }),
    }),
  });

  const data = (await response.json()) as FeishuSendMessageResponse;
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Failed to send Feishu message: HTTP ${response.status}`);
  }

  const messageId = data.data?.message_id;
  if (!messageId) {
    throw new Error('Feishu send message response missing message_id');
  }

  return messageId;
}

export async function editFeishuMessage(messageId: string, text: string): Promise<void> {
  const token = await getFeishuTenantAccessToken();

  const response = await fetch(
    `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    }
  );

  const data = (await response.json()) as FeishuSendMessageResponse;
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Failed to edit Feishu message: HTTP ${response.status}`);
  }
}

function buildApprovalCardButton(
  label: string,
  cmdValue: string,
  type: 'primary' | 'danger' | 'default' = 'default'
) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { cmd: cmdValue },
  };
}

export async function sendFeishuApprovalCard(args: {
  chatId: string;
  interactionRequestId: string;
  command: string;
  kind: string;
}): Promise<string> {
  const token = await getFeishuTenantAccessToken();
  const receiveIdType = 'chat_id';
  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set('receive_id_type', receiveIdType);

  const commandPreview = args.command.slice(0, 800);
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { content: '⚠️ Agent 请求权限确认', tag: 'plain_text' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: `**类型**：${args.kind}\n\`\`\`\n${commandPreview}\n\`\`\``,
      },
      {
        tag: 'action',
        actions: [
          buildApprovalCardButton('✅ 批准', `approve:${args.interactionRequestId}`, 'primary'),
          buildApprovalCardButton('❌ 拒绝', `deny:${args.interactionRequestId}`, 'danger'),
        ],
      },
    ],
  };

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: args.chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });

  const data = (await response.json()) as FeishuSendMessageResponse;
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Failed to send Feishu approval card: HTTP ${response.status}`);
  }

  const messageId = data.data?.message_id;
  if (!messageId) {
    throw new Error('Feishu send interactive message response missing message_id');
  }

  return messageId;
}

export async function updateFeishuApprovalCardResolved(args: {
  messageId: string;
  approved: boolean;
  actorName: string;
}): Promise<void> {
  const token = await getFeishuTenantAccessToken();
  const status = args.approved ? '✅ 已批准' : '❌ 已拒绝';

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `${status} by ${args.actorName}`, tag: 'plain_text' },
      template: args.approved ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'markdown',
        content: `操作人：**${args.actorName}**`,
      },
    ],
  };

  const response = await fetch(
    `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(args.messageId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    }
  );

  const data = (await response.json()) as FeishuSendMessageResponse;
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Failed to update Feishu approval card: HTTP ${response.status}`);
  }
}
