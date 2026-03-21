import { prisma } from '@/lib/prisma';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const DEFAULT_HELP_TEXT = [
  'Agent Platform Feishu Bot',
  '',
  '可用命令：',
  '/ap help',
  '/ap status',
  '/ap gateways',
  '/ap agents <gatewayId>',
  '/ap chat --from=<gatewayId> --to=<gatewayId> [--from-agent=main] [--to-agent=main] [--turns=2] <prompt>',
].join('\n');

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

type ParsedFeishuMessage = {
  chatId: string;
  chatType: string;
  messageId: string;
  senderOpenId: string;
  text: string;
  mentions: string[];
};

type ParsedFeishuCommand = {
  command: 'help' | 'status' | 'gateways' | 'agents' | 'chat';
  args: string[];
  options: Record<string, string>;
};

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

  if (payload.encrypt) {
    throw new Error('Encrypted Feishu events are not supported yet. Disable event encryption or implement FEISHU_ENCRYPT_KEY handling first.');
  }

  if (payload.header?.event_type !== 'im.message.receive_v1') {
    return null;
  }

  const message = payload.event?.message;
  const senderOpenId = payload.event?.sender?.sender_id?.open_id;
  if (!message?.chat_id || !message.message_id || !message.content || !senderOpenId) {
    return null;
  }

  let text = '';
  try {
    const content = JSON.parse(message.content) as { text?: string };
    text = content.text?.trim() || '';
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  return {
    chatId: message.chat_id,
    chatType: message.chat_type || 'group',
    messageId: message.message_id,
    senderOpenId,
    text,
    mentions: (message.mentions || [])
      .map((mention) => mention.id?.open_id)
      .filter((value): value is string => !!value),
  };
}

function stripBotMention(text: string): string {
  return text.replace(/<at user_id="[^"]+">[^<]+<\/at>/g, '').trim();
}

export function parseFeishuCommand(message: ParsedFeishuMessage): ParsedFeishuCommand | null {
  const botOpenId = getOptionalEnv('FEISHU_BOT_OPEN_ID');
  const hasBotMention = botOpenId ? message.mentions.includes(botOpenId) : false;
  const cleanedText = stripBotMention(message.text);
  const normalized = cleanedText.replace(/\s+/g, ' ').trim();

  let commandText = normalized;
  const lower = normalized.toLowerCase();
  if (lower.startsWith('/ap ')) {
    commandText = normalized.slice(4).trim();
  } else if (lower === '/ap') {
    commandText = 'help';
  } else if (lower.startsWith('ap ')) {
    commandText = normalized.slice(3).trim();
  } else if (hasBotMention) {
    commandText = normalized || 'help';
  } else if (message.chatType !== 'p2p') {
    return null;
  }

  if (!commandText) {
    return { command: 'help', args: [], options: {} };
  }

  const tokens = commandText.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const normalizedTokens = tokens.map((token) =>
    token.startsWith('"') || token.startsWith("'")
      ? token.slice(1, -1)
      : token
  );

  const [rawCommand = 'help', ...rest] = normalizedTokens;
  const command = rawCommand.toLowerCase();
  if (!['help', 'status', 'gateways', 'agents', 'chat'].includes(command)) {
    return null;
  }

  const args: string[] = [];
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      if (key && value) {
        options[key] = value;
      }
    } else {
      args.push(token);
    }
  }

  return {
    command: command as ParsedFeishuCommand['command'],
    args,
    options,
  };
}

function formatGatewayLine(gateway: {
  name: string;
  id: string;
  status: string;
  hasOpenClawToken: boolean;
  agentCount: number;
}) {
  const statusIcon = gateway.status === 'online' ? '🟢' : '⚪';
  const tokenStatus = gateway.hasOpenClawToken ? 'OpenClaw ready' : '缺少 token';
  return `${statusIcon} ${gateway.name} (${gateway.id}) | ${gateway.status} | ${tokenStatus} | agents=${gateway.agentCount}`;
}

async function handleStatusCommand() {
  const [gatewayCount, onlineGatewayCount, agentCount, onlineAgentCount, sessionCount] =
    await Promise.all([
      prisma.gateway.count(),
      prisma.gateway.count({ where: { status: 'online' } }),
      prisma.agent.count(),
      prisma.agent.count({ where: { status: 'online' } }),
      prisma.crossGatewayChatSession.count().catch(() => 0),
    ]);

  return [
    'Agent Platform 状态',
    `Gateways: ${onlineGatewayCount}/${gatewayCount} online`,
    `Agents: ${onlineAgentCount}/${agentCount} online`,
    `Cross-gateway sessions: ${sessionCount}`,
  ].join('\n');
}

async function handleGatewaysCommand() {
  const gateways = await prisma.gateway.findMany({
    include: {
      agents: {
        select: {
          id: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 12,
  });

  if (gateways.length === 0) {
    return '当前还没有已注册的 Gateway。';
  }

  return ['Gateway 列表', ...gateways.map((gateway) =>
    formatGatewayLine({
      name: gateway.name,
      id: gateway.id,
      status: gateway.status,
      hasOpenClawToken: !!gateway.openclawToken,
      agentCount: gateway.agents.length,
    })
  )].join('\n');
}

async function handleAgentsCommand(command: ParsedFeishuCommand) {
  const gatewayId = command.args[0];
  const agents = await prisma.agent.findMany({
    where: gatewayId ? { gatewayId } : undefined,
    orderBy: [
      { gatewayId: 'asc' },
      { name: 'asc' },
    ],
    take: 20,
  });

  if (agents.length === 0) {
    return gatewayId
      ? `Gateway ${gatewayId} 下还没有可见 agents。`
      : '当前还没有 agents。';
  }

  return [
    gatewayId ? `Agents for ${gatewayId}` : 'Agents',
    ...agents.map((agent) => {
      const runtimeId = agent.runtimeAgentId || agent.id;
      const gatewayLabel = agent.gatewayId || 'local';
      return `- ${agent.name} (${runtimeId}) | ${gatewayLabel} | ${agent.status}`;
    }),
  ].join('\n');
}

async function handleChatCommand(
  command: ParsedFeishuCommand,
  baseUrl: string
) {
  const fromGatewayId = command.options['from'];
  const toGatewayId = command.options['to'];
  const prompt = command.args.join(' ').trim();

  if (!fromGatewayId || !toGatewayId || !prompt) {
    return [
      'chat 命令参数不足。',
      '示例：',
      '/ap chat --from=<gatewayId> --to=<gatewayId> --from-agent=main --to-agent=main --turns=2 请讨论一下当前需求',
    ].join('\n');
  }

  const response = await fetch(new URL('/api/gateways/chat', baseUrl).toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromGatewayId,
      toGatewayId,
      fromAgentId: command.options['from-agent'] || 'main',
      toAgentId: command.options['to-agent'] || 'main',
      turns: command.options['turns'] === '1' ? 1 : 2,
      prompt,
    }),
  });

  const data = (await response.json()) as {
    error?: string;
    messages?: Array<{
      gatewayId: string | null;
      agentId: string | null;
      text: string;
    }>;
  };

  if (!response.ok) {
    throw new Error(data.error || 'Failed to run cross-gateway chat');
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const transcript = messages
    .map((message) => {
      const speaker = message.gatewayId || 'user';
      const agent = message.agentId ? ` / ${message.agentId}` : '';
      return `${speaker}${agent}\n${message.text}`;
    })
    .join('\n\n');

  return ['Cross-gateway chat 已完成', transcript || '(空回复)'].join('\n\n');
}

export async function handleFeishuCommand(args: {
  command: ParsedFeishuCommand;
  baseUrl: string;
}) {
  switch (args.command.command) {
    case 'help':
      return DEFAULT_HELP_TEXT;
    case 'status':
      return handleStatusCommand();
    case 'gateways':
      return handleGatewaysCommand();
    case 'agents':
      return handleAgentsCommand(args.command);
    case 'chat':
      return handleChatCommand(args.command, args.baseUrl);
    default:
      return DEFAULT_HELP_TEXT;
  }
}
