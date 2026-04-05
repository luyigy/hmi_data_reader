import crypto from 'node:crypto';
import { AESCipher } from '@larksuiteoapi/node-sdk';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';
import { getRealAgentsStatus } from '@/lib/real-agents';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';
import {
  ensureFeishuConversationBinding,
  parseFeishuSelectedAgentIds,
  postFeishuMessageToBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import { sendFeishuTextMessage } from '@/lib/feishu-api';
import { listPendingTaskRunInteractionRequests } from '@/lib/acpx/interactions';
import { resolveInteractionRequestWithContinuation } from '@/lib/acpx/interaction-actions';
const DEFAULT_HELP_TEXT = [
  'Agent Platform Feishu Bot',
  '',
  '可用命令：',
  '/ap help',
  '/ap status',
  '/ap gateways',
  '/ap agents [gatewayId]',
  '/ap hosts',
  '/ap register --label=<名称> --host=<IP> --user=<用户> --keyfile=<私钥路径> [--harnesses=claude,codex] [--port=22] [--network=wireguard|lan|public]',
  '/ap run --host=<hostId|label> --harness=<codex|claude> <prompt>',
  '/ap room --agents=<agentId1,agentId2> [--topic=xxx] [title]',
  '/ap members',
  '/ap nick --member=<memberName|idSuffix> --name=<newNickname>',
  '/ap speaker [memberName|idSuffix]',
  '/ap add --agents=<agentId>',
  '/ap kick <memberName>',
  '/ap chat [--agents=<agentId1,agentId2>] <message>',
  '/ap chat --from=<gatewayId> --to=<gatewayId> <prompt>',
  '/ap approvals',
  '/ap approve <approvalId>',
  '/ap deny <approvalId> [reason]',
  '/ap answer <approvalId> <text>',
].join('\n');

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
  mentionNames: string[];
};

type ParsedFeishuCommand = {
  command: 'help' | 'status' | 'gateways' | 'agents' | 'hosts' | 'run' | 'register' | 'room' | 'members' | 'nick' | 'speaker' | 'kick' | 'add' | 'chat' | 'approvals' | 'approve' | 'deny' | 'answer';
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
    mentionNames: (message.mentions || [])
      .map((mention) => mention.name?.trim())
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
  if (!['help', 'status', 'gateways', 'agents', 'hosts', 'run', 'register', 'room', 'members', 'nick', 'speaker', 'kick', 'add', 'chat', 'approvals', 'approve', 'deny', 'answer'].includes(command)) {
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

async function handleHostsCommand() {
  const hosts = await prisma.remoteHarnessHost.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  if (hosts.length === 0) {
    return '当前没有已注册的 SSH 主机。\n可通过 /remote-ssh-tools 页面注册主机。';
  }

  const lines = hosts.map((host) => {
    let harnesses: string[] = [];
    try { harnesses = JSON.parse(host.supportedHarnesses || '[]'); } catch { /* noop */ }
    const icon = host.status === 'online' ? '🟢' : host.status === 'maintenance' ? '🟡' : '⚪';
    const agentIds = harnesses.map((h) => `  /ap add --agents=remote_ssh:${host.id}:${h}`).join('\n');
    return `${icon} ${host.label}\n  ${host.sshUser}@${host.host}:${host.port} (${host.viaNetwork})\n${agentIds}`;
  });

  return ['SSH 主机列表 (/ap hosts)', ...lines].join('\n\n');
}

async function handleRunCommand(command: ParsedFeishuCommand) {
  const hostQuery = command.options['host'];
  const harnessType = (command.options['harness'] || 'codex').toLowerCase();
  const prompt = command.args.join(' ').trim();

  if (!hostQuery || !prompt) {
    return [
      'run 命令参数不足。',
      '示例：',
      '/ap run --host=<hostId|label> --harness=codex <prompt>',
      '/ap run --host=myserver --harness=claude 帮我看看当前目录有哪些文件',
      '可用主机：/ap hosts',
    ].join('\n');
  }

  const allHosts = await prisma.remoteHarnessHost.findMany({ take: 50 });
  const host = allHosts.find((h) =>
    h.id === hostQuery ||
    h.id.slice(-8) === hostQuery ||
    h.label.toLowerCase() === hostQuery.toLowerCase() ||
    h.label.toLowerCase().includes(hostQuery.toLowerCase())
  );

  if (!host) {
    const names = allHosts.map((h) => `${h.label} [${h.id.slice(-8)}]`).join(', ');
    return `找不到 SSH 主机：${hostQuery}\n已注册主机：${names || '(none)'}`;
  }

  let harnesses: string[] = [];
  try { harnesses = JSON.parse(host.supportedHarnesses || '[]'); } catch { /* noop */ }

  if (!harnesses.includes(harnessType)) {
    return `主机 "${host.label}" 不支持 harness: ${harnessType}\n支持的 harnesses: ${harnesses.join(', ') || '(none)'}`;
  }

  if (!host.encryptedPrivateKey) {
    return `主机 "${host.label}" 未配置私钥，无法执行 SSH 命令。`;
  }

  const { executeRemoteSshTask } = await import('@/lib/remote-harness/ssh-executor');
  const { decryptToken } = await import('@/lib/encryption');

  const hostRecord = {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    sshUser: host.sshUser,
    authType: host.authType,
    privateKey: decryptToken(host.encryptedPrivateKey),
    workingDirectory: host.workingDirectory,
    status: host.status,
    viaNetwork: host.viaNetwork,
    supportedHarnesses: harnesses,
  };

  const result = await executeRemoteSshTask(
    {
      id: `feishu-run-${Date.now()}`,
      name: prompt.slice(0, 80),
      description: prompt,
    },
    {
      timeout: 5 * 60 * 1000,
      harnessType,
      host: hostRecord,
    }
  );

  const lines = [
    `✅ ${host.label} (${harnessType}) 执行完成，耗时 ${Math.round(result.executionTime / 1000)}s`,
    '',
    result.output.trim() || '(无输出)',
  ];

  if (result.sessionId) {
    lines.push('', `Session ID: ${result.sessionId}`);
  }

  return lines.join('\n');
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

async function handleRegisterCommand(command: ParsedFeishuCommand) {
  const label = command.options['label'] || command.args[0];
  const host = command.options['host'];
  const sshUser = command.options['user'];
  const keyFile = command.options['keyfile'];
  const harnesses = (command.options['harnesses'] || 'claude')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const port = parseInt(command.options['port'] || '22', 10);
  const workingDirectory = command.options['workdir'] || null;
  const viaNetwork = ['lan', 'public', 'wireguard'].includes(command.options['network'] || '')
    ? command.options['network']
    : 'wireguard';

  if (!label || !host || !sshUser || !keyFile) {
    return [
      '用法：',
      '/ap register --label=<名称> --host=<IP> --user=<ssh用户> --keyfile=<私钥路径> [--harnesses=claude,codex] [--port=22] [--workdir=<路径>] [--network=wireguard|lan|public]',
      '',
      '示例：',
      '/ap register --label=TX-server --host=10.0.8.10 --user=ubuntu --keyfile=/home/ubuntu/.ssh/id_rsa --harnesses=claude,codex --network=wireguard',
      '',
      '注意：私钥文件路径是平台服务器上的本地路径。',
    ].join('\n');
  }

  const { promises: fsPromises } = await import('fs');
  let privateKey: string;
  try {
    privateKey = await fsPromises.readFile(keyFile, 'utf-8');
  } catch (err) {
    return `读取私钥文件失败：${keyFile}\n错误：${err instanceof Error ? err.message : String(err)}`;
  }

  if (!privateKey.trim().startsWith('-----BEGIN')) {
    return `文件 ${keyFile} 内容不像 PEM 格式的私钥，请检查路径是否正确。`;
  }

  if (harnesses.includes('codex') && sshUser === 'root') {
    return '使用 codex 时不能用 root 用户（codex 在 root 下会拒绝 bypassPermissions 模式）。';
  }

  const { encryptToken } = await import('@/lib/encryption');

  const existing = await prisma.remoteHarnessHost.findFirst({
    where: { host, sshUser },
  });

  if (existing) {
    await prisma.remoteHarnessHost.update({
      where: { id: existing.id },
      data: {
        label,
        port,
        encryptedPrivateKey: encryptToken(privateKey.trim()),
        workingDirectory,
        status: 'offline',
        viaNetwork,
        supportedHarnesses: JSON.stringify(harnesses),
      },
    });

    return [
      `✅ 已更新 SSH 主机：${label}`,
      `ID: ${existing.id}`,
      `地址：${sshUser}@${host}:${port} (${viaNetwork})`,
      `支持的 harnesses：${harnesses.join(', ')}`,
      '',
      '添加到房间：',
      ...harnesses.map((h) => `/ap add --agents=remote_ssh:${existing.id}:${h}`),
    ].join('\n');
  }

  const created = await prisma.remoteHarnessHost.create({
    data: {
      label,
      host,
      port,
      sshUser,
      authType: 'ssh_key',
      encryptedPrivateKey: encryptToken(privateKey.trim()),
      workingDirectory,
      status: 'offline',
      viaNetwork,
      supportedHarnesses: JSON.stringify(harnesses),
    },
  });

  return [
    `✅ 已注册 SSH 主机：${label}`,
    `ID: ${created.id}`,
    `地址：${sshUser}@${host}:${port} (${viaNetwork})`,
    `支持的 harnesses：${harnesses.join(', ')}`,
    '',
    '添加到房间：',
    ...harnesses.map((h) => `/ap add --agents=remote_ssh:${created.id}:${h}`),
  ].join('\n');
}

async function getBoundLiveRoomId(context?: FeishuConversationContext): Promise<string | null> {
  if (!context) return null;
  const scopeKey = context.chatType === 'p2p'
    ? `feishu:p2p:${context.chatId}`
    : `feishu:group:${context.chatId}`;
  const rows = await prisma.$queryRaw<{ liveRoomId: string }[]>`
    SELECT "liveRoomId" FROM "FeishuConversationBinding" WHERE "scopeKey" = ${scopeKey} LIMIT 1
  `;
  return rows[0]?.liveRoomId ?? null;
}

async function getBoundSourceTaskId(context?: FeishuConversationContext): Promise<string | null> {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) return null;

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { sourceTaskId: true },
  });

  return room?.sourceTaskId ?? null;
}

async function findPendingInteractionRequestForTask(taskId: string, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const requests = await listPendingTaskRunInteractionRequests({ taskId });
  return requests.find((request) =>
    request.id.toLowerCase() === normalized
    || request.id.slice(-8).toLowerCase() === normalized
  ) || null;
}

async function handleMembersCommand(context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。请先使用 /ap room --agents=<agentId> 创建绑定。';
  }

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    orderBy: { sortOrder: 'asc' },
  });

  if (members.length === 0) {
    return `Live Room ${roomId} 没有成员。`;
  }

  const lines = members.map((m) => {
    const tag = m.memberType === 'user' ? '(you)' : m.presenceStatus;
    return `- ${m.displayName} [${m.id.slice(-8)}] | ${m.backend || 'local'} | ${tag}`;
  });

  return [`Live Room 成员列表 (${roomId.slice(-8)})`, ...lines].join('\n');
}

async function handleNickCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const memberQuery = (command.options['member'] || command.args[0] || '').trim().replace(/^[@$]/, '');
  const nickname = (command.options['name'] || command.args.slice(1).join(' ') || '').trim();

  if (!memberQuery || !nickname) {
    return [
      '请指定成员和新昵称。',
      '示例：/ap nick --member="hk-vision Claude" --name="hk-vision"',
      '示例：/ap nick claude local-claude',
    ].join('\n');
  }

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    include: {
      gateway: true,
    },
    orderBy: { sortOrder: 'asc' },
  });

  const target = members.find((m) =>
    m.memberType !== 'user' && (
      `${m.displayName} [${m.id.slice(-8)}]`.toLowerCase() === memberQuery.toLowerCase() ||
      m.displayName.toLowerCase() === memberQuery.toLowerCase() ||
      (m.userNickname || '').toLowerCase() === memberQuery.toLowerCase() ||
      (m.shortAlias || '').toLowerCase() === memberQuery.toLowerCase() ||
      m.displayName.toLowerCase().includes(memberQuery.toLowerCase()) ||
      m.id.endsWith(memberQuery)
    )
  );

  if (!target) {
    const names = members
      .filter((m) => m.memberType !== 'user')
      .map((m) => `${m.displayName} [${m.id.slice(-8)}]`)
      .join(', ');
    return `找不到成员：${memberQuery}\n当前成员：${names || '(none)'}`;
  }

  const shortAlias = generateShortAlias(
    nickname,
    target.harnessType || 'unknown',
    target.gateway?.name || null,
    target.backend
  );

  const updated = await prisma.liveRoomMember.update({
    where: { id: target.id },
    data: {
      userNickname: nickname,
      shortAlias,
    },
  });

  return `✅ 已将 ${target.displayName} 重命名为 ${updated.userNickname}。\n后续可直接使用 $${updated.userNickname} 进行 mention。`;
}

async function handleSpeakerCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { currentSpeakerMemberId: true },
  });

  const members = await prisma.liveRoomMember.findMany({
    where: { roomId },
    orderBy: { sortOrder: 'asc' },
  });

  const query = (command.options['member'] || command.args.join(' ') || '').trim().replace(/^[@$]/, '');
  if (!query) {
    const current = members.find((member) => member.id === room?.currentSpeakerMemberId) || null;
    return current
      ? `当前默认 speaker：${current.userNickname || current.displayName} [${current.id.slice(-8)}]`
      : '当前房间还没有默认 speaker。';
  }

  const target = members.find((m) =>
    m.memberType !== 'user' && (
      `${m.displayName} [${m.id.slice(-8)}]`.toLowerCase() === query.toLowerCase() ||
      m.displayName.toLowerCase() === query.toLowerCase() ||
      (m.userNickname || '').toLowerCase() === query.toLowerCase() ||
      (m.shortAlias || '').toLowerCase() === query.toLowerCase() ||
      m.displayName.toLowerCase().includes(query.toLowerCase()) ||
      m.id.endsWith(query)
    )
  );

  if (!target) {
    const names = members
      .filter((m) => m.memberType !== 'user')
      .map((m) => `${m.userNickname || m.displayName} [${m.id.slice(-8)}]`)
      .join(', ');
    return `找不到成员：${query}\n当前可切换 speaker 的成员：${names || '(none)'}`;
  }

  await prisma.liveRoom.update({
    where: { id: roomId },
    data: {
      currentSpeakerMemberId: target.id,
    },
  });

  return `✅ 默认 speaker 已切换为 ${target.userNickname || target.displayName} [${target.id.slice(-8)}]`;
}

async function handleKickCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const nameQuery = command.args.join(' ').trim().replace(/^@/, '');
  if (!nameQuery) {
    return '请指定要移除的成员名称。\n示例：/ap kick claude';
  }

  const members = await prisma.liveRoomMember.findMany({ where: { roomId } });
  const target = members.find((m) =>
    m.memberType !== 'user' && (
      `${m.displayName} [${m.id.slice(-8)}]`.toLowerCase() === nameQuery.toLowerCase() ||
      m.displayName.toLowerCase() === nameQuery.toLowerCase() ||
      (m.userNickname || '').toLowerCase() === nameQuery.toLowerCase() ||
      (m.shortAlias || '').toLowerCase() === nameQuery.toLowerCase() ||
      m.displayName.toLowerCase().includes(nameQuery.toLowerCase()) ||
      m.id.endsWith(nameQuery)
    )
  );

  if (!target) {
    const names = members
      .filter((m) => m.memberType !== 'user')
      .map((m) => m.userNickname || m.displayName)
      .join(', ');
    return `找不到成员：${nameQuery}\n当前可踢出的成员：${names || '(none)'}`;
  }

  await fetch(new URL(
    `/api/live-rooms/${roomId}/members/${target.id}`,
    process.env.AGENT_PLATFORM_BASE_URL?.trim() || 'http://127.0.0.1:3010'
  ).toString(), { method: 'DELETE' });

  return `✅ 已将 ${target.displayName} 从房间移除。`;
}

async function handleAddCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const agentIds = (command.options['agents'] || command.args.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (agentIds.length === 0) {
    return '请指定要添加的 agent ID。\n示例：/ap add --agents=platform_local:platform-local:codex';
  }

  // Re-use the existing room binding add path
  const { ensureFeishuConversationBinding } = await import('@/lib/feishu-live-room');
  if (!context) return '需要 Feishu 会话上下文。';
  const result = await ensureFeishuConversationBinding({ context, selectedAgentIds: agentIds });
  return `✅ 已添加 ${result.addedAgentCount} 个成员到 Live Room ${result.liveRoomId.slice(-8)}。\n可使用 /ap members 查看当前成员列表。`;
}

async function handleApprovalsCommand(context?: FeishuConversationContext) {
  const taskId = await getBoundSourceTaskId(context);
  if (!taskId) {
    return '当前 Feishu 会话未绑定可继续的 task 上下文，无法查看 pending approvals。';
  }

  const requests = await listPendingTaskRunInteractionRequests({ taskId });
  if (requests.length === 0) {
    return '当前没有 pending approvals。';
  }

  const lines = requests.slice(0, 10).map((request) => {
    const shortId = request.id.slice(-8);
    return `- ${shortId} | ${request.requestKind} | ${request.message}`;
  });

  return [
    'Pending approvals',
    ...lines,
    '',
    '处理示例：',
    '/ap approve <id>',
    '/ap deny <id> 原因',
    '/ap answer <id> 你的回复',
  ].join('\n');
}

async function handleApproveLikeCommand(args: {
  command: ParsedFeishuCommand;
  context?: FeishuConversationContext;
  action: 'approve' | 'deny' | 'answer';
}) {
  const taskId = await getBoundSourceTaskId(args.context);
  if (!taskId) {
    return '当前 Feishu 会话未绑定可继续的 task 上下文，无法处理 approval。';
  }

  const requestQuery = (args.command.args[0] || '').trim();
  if (!requestQuery) {
    return args.action === 'approve'
      ? '请指定 approval id。\n示例：/ap approve abc12345'
      : args.action === 'deny'
      ? '请指定 approval id。\n示例：/ap deny abc12345 不允许联网'
      : '请指定 approval id 和回复内容。\n示例：/ap answer abc12345 staging';
  }

  const responseText = args.command.args.slice(1).join(' ').trim() || null;
  if (args.action === 'answer' && !responseText) {
    return '请提供 answer 内容。\n示例：/ap answer abc12345 staging';
  }

  const request = await findPendingInteractionRequestForTask(taskId, requestQuery);
  if (!request) {
    return `找不到 pending approval：${requestQuery}\n可先使用 /ap approvals 查看当前列表。`;
  }

  const result = await resolveInteractionRequestWithContinuation({
    requestId: request.id,
    action: args.action,
    responseText,
    actor: {
      id: args.context?.senderOpenId || 'feishu-user',
      name: 'Feishu User',
      channel: 'feishu',
    },
  });

  return [
    `✅ approval ${request.id.slice(-8)} 已${args.action === 'deny' ? '拒绝' : '处理'}`,
    `类型：${request.requestKind}`,
    `状态：${result.status}`,
    result.resumed
      ? `已继续会话，新的 run：${result.continuationRunId}`
      : result.resumeError
      ? `未自动继续：${result.resumeError}`
      : '当前未自动继续会话。',
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
    case 'hosts':
      return handleHostsCommand();
    case 'run':
      return handleRunCommand(args.command);
    case 'register':
      return handleRegisterCommand(args.command);
    case 'room':
      return handleRoomCommand(args.command, args.context);
    case 'members':
      return handleMembersCommand(args.context);
    case 'nick':
      return handleNickCommand(args.command, args.context);
    case 'speaker':
      return handleSpeakerCommand(args.command, args.context);
    case 'kick':
      return handleKickCommand(args.command, args.context);
    case 'add':
      return handleAddCommand(args.command, args.context);
    case 'chat':
      return handleChatCommand(args.command, args.baseUrl, args.context);
    case 'approvals':
      return handleApprovalsCommand(args.context);
    case 'approve':
      return handleApproveLikeCommand({ command: args.command, context: args.context, action: 'approve' });
    case 'deny':
      return handleApproveLikeCommand({ command: args.command, context: args.context, action: 'deny' });
    case 'answer':
      return handleApproveLikeCommand({ command: args.command, context: args.context, action: 'answer' });
    default:
      return DEFAULT_HELP_TEXT;
  }
}
