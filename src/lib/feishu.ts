import crypto from 'node:crypto';
import { AESCipher } from '@larksuiteoapi/node-sdk';
import { prisma } from '@/lib/prisma';
import { getRealAgentsStatus } from '@/lib/real-agents';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';
import {
  ensureFeishuConversationBinding,
  parseFeishuSelectedAgentIds,
  postFeishuMessageToBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const DEFAULT_HELP_TEXT = [
  'Agent Platform Feishu Bot',
  '',
  '可用命令：',
  '/ap help',
  '/ap status',
  '/ap gateways',
  '/ap agents <gatewayId>',
  '/ap room --agents=<agentId1,agentId2> [--topic=xxx] [title]',
  '/ap chat --from=<gatewayId> --to=<gatewayId> [--from-agent=main] [--to-agent=main] [--turns=2] <prompt>',
  '/ap chat [--agents=<agentId1,agentId2>] <message>',
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

type FeishuWebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

type ParsedFeishuMessage = {
  chatId: string;
  chatType: string;
  messageId: string;
  senderOpenId: string;
  text: string;
  mentions: string[];
};

type ParsedFeishuCommand = {
  command: 'help' | 'status' | 'gateways' | 'agents' | 'room' | 'chat';
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

function getLocalHarnessStatus(agentName: string, localStatus: Awaited<ReturnType<typeof getRealAgentsStatus>>) {
  const normalized = agentName.trim().toLowerCase();
  if (normalized.includes('codex')) {
    return localStatus.codex.available ? 'online' : 'offline';
  }
  if (normalized.includes('claude')) {
    return localStatus.claude.available ? 'online' : 'offline';
  }
  return 'offline';
}

function getEffectiveAgentStatus(
  agent: {
    status: string;
    lastHeartbeat: Date;
    gatewayId: string | null;
    hostname: string | null;
    name: string;
  },
  localStatus: Awaited<ReturnType<typeof getRealAgentsStatus>>,
  currentHostname: string
) {
  if (agent.hostname) {
    if (agent.hostname !== currentHostname) {
      return 'offline';
    }
    return getLocalHarnessStatus(agent.name, localStatus);
  }

  return agent.status;
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
  if (!['help', 'status', 'gateways', 'agents', 'room', 'chat'].includes(command)) {
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
  await ensurePlatformLocalAgents();
  const gatewayId = command.args[0];
  const currentHostname = getServerHostname();
  const [agents, localStatus] = await Promise.all([
    prisma.agent.findMany({
      where: gatewayId ? { gatewayId } : undefined,
      orderBy: [
        { gatewayId: 'asc' },
        { name: 'asc' },
      ],
      take: 40,
    }),
    getRealAgentsStatus(),
  ]);

  if (agents.length === 0) {
    return gatewayId
      ? `Gateway ${gatewayId} 下还没有可见 agents。`
      : '当前还没有 agents。';
  }

  const normalizedAgents = agents
    .map((agent) => ({
      ...agent,
      effectiveStatus: getEffectiveAgentStatus(agent, localStatus, currentHostname),
    }))
    .filter((agent) => !agent.hostname || agent.hostname === currentHostname || agent.effectiveStatus !== 'offline');

  return [
    gatewayId ? `Agents for ${gatewayId}` : 'Agents',
    ...normalizedAgents.map((agent) => {
      const runtimeId = agent.runtimeAgentId || agent.id;
      const gatewayLabel = agent.gatewayId || 'local';
      return `- ${agent.name} (${runtimeId}) | ${gatewayLabel} | ${agent.effectiveStatus}`;
    }),
  ].join('\n');
}

async function handleChatCommand(
  command: ParsedFeishuCommand,
  baseUrl: string,
  context?: FeishuConversationContext
) {
  const fromGatewayId = command.options['from'];
  const toGatewayId = command.options['to'];
  const prompt = command.args.join(' ').trim();

  if (fromGatewayId || toGatewayId) {
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

  if (!context) {
    return '当前 chat 模式需要来自 Feishu webhook 的会话上下文。';
  }

  if (!prompt) {
    return [
      'chat 命令参数不足。',
      '示例：',
      '/ap chat --agents=<agentId1,agentId2> 先建立一个房间并开始讨论',
      '/ap chat 继续讨论这个问题',
    ].join('\n');
  }

  const selectedAgentIds = parseFeishuSelectedAgentIds(command.options['agents']);
  await ensureFeishuConversationBinding({
    context,
    selectedAgentIds,
    title: command.options['title'],
    topic: command.options['topic'],
  });

  const result = await postFeishuMessageToBoundLiveRoom({
    context,
    content: prompt,
  });

  const targetedNames = result.targetedMembers.map((member) => member.displayName).join(', ');
  const pendingReplyNames = result.pendingReplies.map((reply) => reply.displayName).join(', ');
  return [
    `消息已写入 Live Room ${result.liveRoomId}`,
    result.mentionedAll
      ? '本条消息目标：全部房间成员'
      : result.targetedMembers.length > 0
      ? `本条消息目标：${targetedNames}`
      : '本条消息目标：未指定，按当前房间路由处理',
    result.pendingReplies.length > 0
      ? `房间待回复成员：${pendingReplyNames}`
      : '当前没有待回复成员。若需要触发指定 agent，请在消息里 @房间成员名称。',
  ].join('\n');
}

async function handleRoomCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext
) {
  if (!context) {
    return '当前 room 命令需要来自 Feishu webhook 的会话上下文。';
  }

  const selectedAgentIds = parseFeishuSelectedAgentIds(command.options['agents']);
  const title = command.args.join(' ').trim() || command.options['title'];
  const result = await ensureFeishuConversationBinding({
    context,
    selectedAgentIds,
    title,
    topic: command.options['topic'],
  });

  return [
    result.created ? '已创建 Feishu 绑定房间。' : '已复用现有 Feishu 绑定房间。',
    `Live Room: ${result.roomTitle} (${result.liveRoomId})`,
    `新增成员数：${result.addedAgentCount}`,
    '接下来可以直接发送：/ap chat 你的消息',
  ].join('\n');
}

export async function handleFeishuCommand(args: {
  command: ParsedFeishuCommand;
  baseUrl: string;
  context?: FeishuConversationContext;
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
    case 'room':
      return handleRoomCommand(args.command, args.context);
    case 'chat':
      return handleChatCommand(args.command, args.baseUrl, args.context);
    default:
      return DEFAULT_HELP_TEXT;
  }
}
