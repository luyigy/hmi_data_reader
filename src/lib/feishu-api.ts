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

export async function getFeishuUserDisplayName(openId: string): Promise<string | null> {
  const token = await getFeishuTenantAccessToken();
  const url = new URL(`${FEISHU_API_BASE}/contact/v3/users/${encodeURIComponent(openId)}`);
  url.searchParams.set('user_id_type', 'open_id');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json() as { code?: number; msg?: string; data?: { user?: { name?: string } } };
  if (!response.ok || data.code !== 0) throw new Error(data.msg || `Failed to get Feishu user: HTTP ${response.status}`);
  return data.data?.user?.name?.trim() || null;
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
}): Promise<string | undefined> {
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

  return data.data?.message_id;
}

async function sendFeishuWorkflowMessage(args: {
  chatId: string;
  content: Record<string, unknown>;
  messageType: 'text' | 'interactive';
  idempotencyKey: string;
}): Promise<string> {
  const token = await getFeishuTenantAccessToken();
  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set('receive_id_type', 'chat_id');
  url.searchParams.set('uuid', args.idempotencyKey);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: args.chatId,
      msg_type: args.messageType,
      content: JSON.stringify(args.content),
    }),
  });
  const data = (await response.json()) as FeishuSendMessageResponse;
  const messageId = data.data?.message_id;
  if (!response.ok || data.code !== 0 || !messageId) {
    throw new Error(data.msg || `Failed to send Feishu workflow message: HTTP ${response.status}`);
  }
  return messageId;
}

export const sendFeishuWorkflowTextMessage = (args: {
  chatId: string;
  text: string;
  idempotencyKey: string;
}) => sendFeishuWorkflowMessage({
  chatId: args.chatId,
  content: { text: args.text },
  messageType: 'text',
  idempotencyKey: args.idempotencyKey,
});

export const sendFeishuWorkflowReviewCard = (args: {
  chatId: string;
  projectId: string;
  jobId: string;
  pendingKey: string;
  approverOpenId: string;
  planPath: string;
  planUrl: string;
  reviewedCommit: string;
  expiresAt: string;
  reviewAttempt: number;
  idempotencyKey: string;
  workflowContext: string;
}) => sendFeishuWorkflowMessage({
  chatId: args.chatId,
  messageType: 'interactive',
  idempotencyKey: args.idempotencyKey,
  content: {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'PLAN 审批' },
    },
    elements: [
      {
        tag: 'markdown',
        content: `<at id=${args.approverOpenId}></at>\n**文档**：${path.posix.basename(args.planPath)}\n`
          + `**查看计划**：[打开飞书文档](${args.planUrl})\n`
          + `**路径**：${args.planPath}\n${args.workflowContext}\n`
          + `**提交**：${args.reviewedCommit}\n**截止**：${args.expiresAt}`,
      },
      {
        tag: 'action',
        actions: [
          ['批准', 'approve', 'primary'],
          ['拒绝', 'reject', 'danger'],
        ].map(([label, decision, type]) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: label },
          type,
          value: {
            cmd: 'workflow-review',
            decision,
            projectId: args.projectId,
            jobId: args.jobId,
            pendingKey: args.pendingKey,
            reviewAttempt: args.reviewAttempt,
          },
        })),
      },
      {
        tag: 'form',
        name: 'workflowReviewRevision',
        elements: [
          {
            tag: 'input',
            name: 'reviewFeedback',
            required: false,
            input_type: 'multiline_text',
            rows: 6,
            max_rows: 12,
            auto_resize: true,
            width: 'fill',
            label: { tag: 'plain_text', content: '修改意见（可选）' },
            placeholder: { tag: 'plain_text', content: '填写具体意见；留空时 Coding Agent 会主动询问' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '修改' },
            type: 'default',
            action_type: 'form_submit',
            name: 'submitRevision',
            value: {
              cmd: 'workflow-review',
              decision: 'revision',
              projectId: args.projectId,
              jobId: args.jobId,
              pendingKey: args.pendingKey,
            },
          },
        ],
      },
    ],
  },
});

export const sendFeishuWorkflowRevisionFeedbackCard = (args: {
  chatId: string;
  projectId: string;
  jobId: string;
  pendingKey: string;
  approverOpenId: string;
  planPath: string;
  idempotencyKey: string;
}) => sendFeishuWorkflowMessage({
  chatId: args.chatId,
  messageType: 'interactive',
  idempotencyKey: args.idempotencyKey,
  content: {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'PLAN 修改意见' },
    },
    elements: [
      {
        tag: 'markdown',
        content: `<at id=${args.approverOpenId}></at>\n请填写 **${path.posix.basename(args.planPath)}** 的具体修改意见。提交后才会启动 Coding Agent。`,
      },
      {
        tag: 'form',
        name: 'workflowRevisionFeedback',
        elements: [
          {
            tag: 'input',
            name: 'reviewFeedback',
            required: true,
            input_type: 'multiline_text',
            rows: 6,
            max_rows: 12,
            auto_resize: true,
            width: 'fill',
            label: { tag: 'plain_text', content: '修改意见' },
            placeholder: { tag: 'plain_text', content: '请明确说明需要修改的内容' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '提交修改意见' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submitRevisionFeedback',
            value: {
              cmd: 'workflow-revision-feedback',
              projectId: args.projectId,
              jobId: args.jobId,
              pendingKey: args.pendingKey,
            },
          },
        ],
      },
    ],
  },
});

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

export const buildFeishuPermissionCard = (args: {
  interactionRequestId: string;
  command: string;
  kind: string;
  workdir: string;
  workspaceBoundary: string;
  approvalScope: string;
  expiresAt: string;
  approvalSupported: boolean;
}) => ({
    config: { wide_screen_mode: true },
    header: {
      title: { content: '⚠️ Agent 请求权限确认', tag: 'plain_text' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**类型**：${args.kind}`,
          `**命令**：\n\`\`\`\n${args.command.slice(0, 800).replaceAll('```', '｀｀｀')}\n\`\`\``,
          `**当前 workdir**：\`${args.workdir}\``,
          `**边界**：\`${args.workspaceBoundary}\``,
          `**范围**：${args.approvalScope}`,
          `**有效期**：${args.expiresAt}`,
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          ...(args.approvalSupported
            ? [buildApprovalCardButton('✅ 仅批准本次操作', `approve:${args.interactionRequestId}`, 'primary')]
            : []),
          buildApprovalCardButton('❌ 拒绝', `deny:${args.interactionRequestId}`, 'danger'),
        ],
      },
    ],
  });

export async function sendFeishuApprovalCard(args: Parameters<typeof buildFeishuPermissionCard>[0] & {
  chatId: string;
}): Promise<string> {
  const token = await getFeishuTenantAccessToken();
  const receiveIdType = 'chat_id';
  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set('receive_id_type', receiveIdType);
  const card = buildFeishuPermissionCard(args);
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
  approved?: boolean;
  resolution?: 'approved' | 'rejected' | 'revision' | 'expired';
  actorName: string;
}): Promise<void> {
  const token = await getFeishuTenantAccessToken();
  const resolution = args.resolution || (args.approved ? 'approved' : 'rejected');
  const status = resolution === 'approved'
    ? '✅ 已批准'
    : resolution === 'revision'
      ? '✏️ 已请求修改'
      : resolution === 'expired'
        ? '⌛ 已失效'
      : '❌ 已拒绝';

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `${status} by ${args.actorName}`, tag: 'plain_text' },
      template: resolution === 'approved' ? 'green' : resolution === 'revision' ? 'orange' : resolution === 'expired' ? 'grey' : 'red',
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

export async function getFeishuChatInfo(chatId: string): Promise<{ name: string } | null> {
  try {
    const token = await getFeishuTenantAccessToken();
    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/chats/${encodeURIComponent(chatId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const data = await response.json();
    if (data.code === 0 && data.data) {
      return { name: data.data.name };
    }
    return null;
  } catch (error) {
    console.error('Failed to get Feishu chat info:', error);
    return null;
  }
}
