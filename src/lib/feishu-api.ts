const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

type FeishuTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

type FeishuSendMessageResponse = {
  code: number;
  msg?: string;
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
