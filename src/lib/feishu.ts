import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AESCipher } from '@larksuiteoapi/node-sdk';
import { prisma } from '@/lib/prisma';
import { generateShortAlias } from '@/lib/agent-identity';
import { getRealAgentsStatus } from '@/lib/real-agents';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';
import {
  ensureFeishuConversationBinding,
  resolveFeishuSelectedAgentIds,
  resolveDefaultFeishuBindingAgentIds,
  postFeishuMessageToBoundLiveRoom,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';
import {
  downloadFeishuMessageResource,
  sendFeishuInteractiveMessage,
} from '@/lib/feishu-api';
import { listPendingTaskRunInteractionRequests } from '@/lib/acpx/interactions';
import { resolveInteractionRequestWithContinuation } from '@/lib/acpx/interaction-actions';
import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { rotateTaskSession } from '@/lib/acpx/session';
import { createGrantActionToken, grantRightsForRoom, parseGrantProfile } from '@/lib/feishu-grant';
import {
  buildAcpxPermissionConfigForProfile,
  normalizeAcpxPermissionConfig,
  DEFAULT_ACPX_PERMISSION_CONFIG,
} from '@/lib/acpx/permissions';
import {
  buildTaskRoomPromptContext,
  ensureTaskChatRoom,
  postTaskRoomMessage,
  postTaskRoomSessionResetMarker,
} from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import {
  buildLiveRoomAcpxParticipant,
  listLiveRoomCatalogAgents,
  listLiveRoomPendingReplies,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  serializeLiveRoomMembersWithContext,
} from '@/lib/live-room';
import { interruptLiveRoomMemberReplies, triggerLiveRoomMessageReplies } from '@/lib/live-room-delivery';
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
  '/ap run --host=<hostId|label> --harness=<codex|claude|claude-haha> <prompt>',
  '/ap room --agents=<agentId1,agentId2> [--topic=xxx] [--profile=safe|dev|full] [title]  支持短写：TX-server:claude',
  '/ap members',
  '/ap nick --member=<memberName|idSuffix> --name=<newNickname>',
  '/ap speaker [memberName|idSuffix]',
  '/ap add --agents=<agentId>  支持短写：TX-server:claude',
  '/ap kick <memberName>',
  '/ap chat [--agents=<agentId1,agentId2>] <message>',
  '/ap chat --from-member=<memberName> --to-member=<memberName> <message>',
  '/ap chat --from=<gatewayId> --to=<gatewayId> <prompt>',
  '/ap approvals',
  '/ap approve <approvalId>',
  '/ap deny <approvalId> [reason]',
  '/ap answer <approvalId> <text>',
  '/ap grant <dev|full> [--agent=<name>] [message]',
  '/ap rights [--agent=<name>]',
  '/ap handover [agentName|idSuffix] [--title="handover title"]',
  '/ap workspace [/path/to/dir]',
  '/ap new [--blank] [--handover="docs/xx.md"] [--profile=safe|dev|full] [agentName|idSuffix]',
  '/ap new-session [--blank] [--handover="docs/xx.md"] [--profile=safe|dev|full] [agentName|idSuffix]',
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
  messageType: string;
  text: string;
  fileKey?: string | null;
  mentions: string[];
  mentionNames: string[];
};

type ParsedFeishuCommand = {
  command: 'help' | 'status' | 'gateways' | 'agents' | 'hosts' | 'run' | 'register' | 'room' | 'members' | 'nick' | 'speaker' | 'kick' | 'add' | 'chat' | 'approvals' | 'approve' | 'deny' | 'answer' | 'grant' | 'rights' | 'handover' | 'workspace' | 'new-session';
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
  if (normalized === 'claude-haha') {
    return localStatus['claude-haha'].available ? 'online' : 'offline';
  }
  if (normalized.includes('deepseek')) {
    return localStatus.deepseek.available ? 'online' : 'offline';
  }
  if (normalized.includes('gemini')) {
    return localStatus['gemini-cli'].available ? 'online' : 'offline';
  }
  if (normalized.includes('pi-agent') || normalized === 'pi') {
    return localStatus['pi-agent'].available ? 'online' : 'offline';
  }
  if (normalized.includes('codex')) {
    return localStatus.codex.available ? 'online' : 'offline';
  }
  if (normalized === 'claude') {
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
    mentions: (message.mentions || [])
      .map((mention) => mention.id?.open_id)
      .filter((value): value is string => !!value),
    mentionNames: (message.mentions || [])
      .map((mention) => mention.name?.trim())
      .filter((value): value is string => !!value),
  };
}

export function parseFeishuMessageContent(
  messageType: string | undefined,
  rawContent: string
): { text: string | null; messageType: string; fileKey?: string | null } | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }

  const normalizedType = (messageType || 'text').trim().toLowerCase();
  if (normalizedType === 'text') {
    const text = typeof content.text === 'string' ? content.text.trim() : '';
    return {
      text: text || null,
      messageType: normalizedType,
    };
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
    return { text: '[富文本消息]', messageType: normalizedType };
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
  const downloadableType =
    message.messageType === 'image'
      ? 'image'
      : message.messageType === 'file'
      ? 'file'
      : message.messageType === 'audio'
      ? 'audio'
      : message.messageType === 'media'
      ? 'media'
      : null;

  if (!downloadableType || !message.fileKey) {
    return message;
  }

  try {
    const downloaded = await downloadFeishuMessageResource({
      messageId: message.messageId,
      fileKey: message.fileKey,
      type: downloadableType,
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

function stripBotMention(text: string): string {
  return text
    .replace(/<at user_id="[^"]+">[^<]+<\/at>/g, '')
    .replace(/^@\S+\s*/, '')
    .trim();
}

function tokenizeCommandText(input: string) {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
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

  const normalizedTokens = tokenizeCommandText(commandText);

  const [rawCommand = 'help', ...rest] = normalizedTokens;
  const commandAlias = rawCommand.toLowerCase();
  const command = commandAlias === 'new' ? 'new-session' : commandAlias;
  if (!['help', 'status', 'gateways', 'agents', 'hosts', 'run', 'register', 'room', 'members', 'nick', 'speaker', 'kick', 'add', 'chat', 'approvals', 'approve', 'deny', 'answer', 'grant', 'rights', 'handover', 'workspace', 'new-session'].includes(command)) {
    return null;
  }

  const args: string[] = [];
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (token.startsWith('--')) {
      const optionText = token.slice(2);
      const separatorIndex = optionText.indexOf('=');
      if (separatorIndex > 0) {
        const key = optionText.slice(0, separatorIndex);
        const value = optionText.slice(separatorIndex + 1);
        options[key] = value;
      } else if (optionText) {
        options[optionText] = 'true';
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
  const [agents, localStatus, catalogAgents] = await Promise.all([
    prisma.agent.findMany({
      where: gatewayId ? { gatewayId } : undefined,
      orderBy: [
        { gatewayId: 'asc' },
        { name: 'asc' },
      ],
      take: 40,
    }),
    getRealAgentsStatus(),
    listLiveRoomCatalogAgents(),
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
    gatewayId ? `Agents for ${gatewayId}` : 'Agents (用 --agents=<id> 指定)',
    ...normalizedAgents.map((agent) => {
      const gatewayLabel = agent.gatewayId || 'local';
      const status = agent.effectiveStatus;
      const catalog = catalogAgents.find((c) =>
        c.harnessType === (agent.type || agent.name?.toLowerCase()) &&
        (c.gatewayId === agent.gatewayId || (c.gatewayId === 'platform-local' && !agent.gatewayId))
      );
      const catalogId = catalog?.id ?? `platform_local:${gatewayLabel}:${agent.type || agent.name}`;
      const nickname = agent.userNickname ? ` "${agent.userNickname}"` : '';
      return `- ${agent.name}${nickname} | ${status}\n  --agents=${catalogId}`;
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

const resolveLiveRoomMemberByQuery = <T extends {
  id: string;
  memberType: string;
  displayName: string;
  userNickname?: string | null;
  shortAlias?: string | null;
}>(
  members: T[],
  query: string
) => {
  const normalizedQuery = query.trim().replace(/^[@$]/, '').toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  return members.find((member) =>
    member.memberType !== 'user' && (
      `${member.displayName} [${member.id.slice(-8)}]`.toLowerCase() === normalizedQuery ||
      member.displayName.toLowerCase() === normalizedQuery ||
      (member.userNickname || '').toLowerCase() === normalizedQuery ||
      (member.shortAlias || '').toLowerCase() === normalizedQuery ||
      member.displayName.toLowerCase().includes(normalizedQuery) ||
      member.id.endsWith(normalizedQuery)
    )
  ) || null;
};

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
      '/ap chat --from-member=codex --to-member=claude 请确认远端状态',
      '/ap chat 继续讨论这个问题',
    ].join('\n');
  }

  const selectedAgentIds = await resolveFeishuSelectedAgentIds(command.options['agents']);
  const binding = await ensureFeishuConversationBinding({
    context,
    selectedAgentIds,
    title: command.options['title'],
    topic: command.options['topic'],
  });

  const fromMemberQuery = (command.options['from-member'] || '').trim();
  const toMemberQuery = (command.options['to-member'] || '').trim();
  if (fromMemberQuery || toMemberQuery) {
    if (!fromMemberQuery || !toMemberQuery) {
      return [
        '定向 chat 需要同时指定 from-member 和 to-member。',
        '示例：',
        '/ap chat --from-member=codex --to-member=claude 请确认远端状态',
      ].join('\n');
    }

    const roomMembers = await prisma.liveRoomMember.findMany({
      where: { roomId: binding.liveRoomId },
      orderBy: { sortOrder: 'asc' },
    });
    const fromMember = resolveLiveRoomMemberByQuery(roomMembers, fromMemberQuery);
    const toMember = resolveLiveRoomMemberByQuery(roomMembers, toMemberQuery);

    if (!fromMember) {
      const names = roomMembers
        .filter((member) => member.memberType !== 'user')
        .map((member) => `${member.userNickname || member.displayName} [${member.id.slice(-8)}]`)
        .join(', ');
      return `找不到 from-member：${fromMemberQuery}\n当前成员：${names || '(none)'}`;
    }

    if (!toMember) {
      const names = roomMembers
        .filter((member) => member.memberType !== 'user')
        .map((member) => `${member.userNickname || member.displayName} [${member.id.slice(-8)}]`)
        .join(', ');
      return `找不到 to-member：${toMemberQuery}\n当前成员：${names || '(none)'}`;
    }

    if (!toMember.canReply) {
      return `${toMember.userNickname || toMember.displayName} 当前不可回复，不能作为定向消息目标。`;
    }

    const message = await postLiveRoomMessage({
      roomId: binding.liveRoomId,
      senderMemberId: fromMember.id,
      content: prompt,
      messageType: 'assistant',
      visibility: 'directed_visible',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'assistant',
        targetMemberId: toMember.id,
        visibilityMode: 'directed_visible',
        extras: {
          targetMemberName: toMember.userNickname || toMember.displayName,
          source: 'feishu_directed_chat_command',
          targetResolutionSource: 'feishu_chat_from_to_member',
        },
      }),
    });

    await triggerLiveRoomMessageReplies({
      roomId: binding.liveRoomId,
      roomMessageId: message.id,
      requestedTargetMemberId: toMember.id,
    });

    const pendingReplies = await listLiveRoomPendingReplies(binding.liveRoomId);
    return [
      `消息已写入 Live Room ${binding.liveRoomId}`,
      `定向可见通信：${fromMember.userNickname || fromMember.displayName} -> ${toMember.userNickname || toMember.displayName}`,
      pendingReplies.length > 0
        ? `房间待回复成员：${pendingReplies.map((reply) => reply.displayName).join(', ')}`
        : '当前没有待回复成员。',
    ].join('\n');
  }

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

async function getBoundLiveRoom(context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) return null;

  return prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });
}

function resolveRoomMemberQuery(args: {
  room: NonNullable<Awaited<ReturnType<typeof getBoundLiveRoom>>>;
  query?: string | null;
}) {
  const normalizedQuery = args.query?.trim().replace(/^[@$]/, '').toLowerCase() || '';
  const replyableMembers = args.room.members.filter((member) => member.memberType !== 'user' && member.canReply);

  if (!normalizedQuery) {
    return (
      replyableMembers.find((member) => member.id === args.room.currentSpeakerMemberId)
      || replyableMembers[0]
      || null
    );
  }

  return replyableMembers.find((member) =>
    `${member.displayName} [${member.id.slice(-8)}]`.toLowerCase() === normalizedQuery
    || member.displayName.toLowerCase() === normalizedQuery
    || (member.userNickname || '').toLowerCase() === normalizedQuery
    || (member.shortAlias || '').toLowerCase() === normalizedQuery
    || member.displayName.toLowerCase().includes(normalizedQuery)
    || member.id.endsWith(normalizedQuery)
  ) || null;
}

async function handleGrantCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法授权。';
  }

  const profile =
    parseGrantProfile(command.options['profile'])
    || parseGrantProfile(command.args[0])
    || null;
  if (!profile) {
    return [
      '请指定授权档位。',
      '示例：/ap grant full',
      '示例：/ap grant dev --agent=codex',
      '说明：这会立刻更新当前 task session 的有效权限，并用于随后的 continuation；不会原地热切换已经卡住的旧进程 stdin。',
    ].join('\n');
  }

  const consumedFirstArg = !command.options['profile'] && parseGrantProfile(command.args[0]);
  const message = command.args.slice(consumedFirstArg ? 1 : 0).join(' ').trim();
  const memberQuery = (command.options['agent'] || '').trim() || null;
  const result = await grantRightsForRoom({
    roomId,
    profile,
    memberQuery,
    message,
  });

  return [
    `✅ 已授予 ${result.member.userNickname || result.member.displayName} ${profile === 'full_access' ? '完全权限' : '开发权限'}`,
    `Task: ${result.room.sourceTask!.name}`,
    `运行方式：${result.usedContinuation ? '继续原会话' : '启动新 run'}`,
    `新 run：${result.taskRunId}`,
    '说明：权限已写入当前 task session，并已用于这次 continuation / run；不会原地热切换旧进程。',
  ].join('\n');
}

async function handleRightsCommand(args: {
  command: ParsedFeishuCommand;
  baseUrl: string;
  context?: FeishuConversationContext;
}) {
  if (!args.context) {
    return '当前 rights 命令需要来自 Feishu webhook 的会话上下文。';
  }

  const room = await getBoundLiveRoom(args.context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法发送授权卡片。';
  }

  const memberQuery = (args.command.options['agent'] || '').trim();
  const member = resolveRoomMemberQuery({ room, query: memberQuery });
  if (!member) {
    return memberQuery
      ? `找不到目标成员：${memberQuery}`
      : '当前房间没有可授权的 agent 成员。';
  }

  const buildActionUrl = (profile: 'dev_local' | 'full_access') => {
    const token = createGrantActionToken({
      roomId: room.id,
      memberId: member.id,
      profile,
    });
    return new URL(`/api/feishu/grant?token=${encodeURIComponent(token)}`, args.baseUrl).toString();
  };

  await sendFeishuInteractiveMessage({
    receiveId: args.context.chatId,
    receiveIdType: 'chat_id',
    replyId: args.context.messageId,
    card: {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'orange',
        title: {
          tag: 'plain_text',
          content: `给 ${member.userNickname || member.displayName} 授权`,
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: [
            `**Task**: ${room.sourceTask.name}`,
            '点击按钮后会立刻更新当前 task session 的有效权限，并自动 continuation 或启动新的 run。',
            '说明：不会直接把许可写回已经阻塞中的旧进程 stdin。',
          ].join('\n'),
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '授予开发权限并继续',
              },
              type: 'primary',
              url: buildActionUrl('dev_local'),
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '授予完全权限并继续',
              },
              type: 'danger',
              url: buildActionUrl('full_access'),
            },
          ],
        },
      ],
    },
  });

  return `✅ 已发送授权卡片给当前 Feishu 会话，可直接点击按钮给 ${member.userNickname || member.displayName} 授权。`;
}

function sanitizeHandoverSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'handover';
}

function buildHandoverDocBody(args: {
  roomTitle: string;
  memberName: string;
  taskName: string;
  latestUserMessage: string | null;
  transcript: string;
  title: string;
}) {
  return [
    `# ${args.title}`,
    '',
    '## 当前目标',
    args.latestUserMessage || `继续处理 Live Room "${args.roomTitle}" 中分配给 ${args.memberName} 的任务。`,
    '',
    '## 已完成',
    '- 已生成这份 handover 文档。',
    '- 当前 room / task 上下文已整理到本文档中。',
    '',
    '## 未完成',
    '- 需要新 session 继续阅读 handover 并执行下一步。',
    '',
    '## 风险/阻塞',
    '- 旧 session 上下文可能不完整或已接近上限。',
    '- 若涉及 git add / commit，请确认当前执行环境的 `.git` 可写。',
    '',
    '## 下一步',
    `- 先阅读本文档，再继续处理 ${args.memberName} 的当前任务。`,
    '- 复述当前状态。',
    '- 执行最直接的下一步，并在必要时回写新的 handover。',
    '',
    '## 相关文件',
    `- Task: ${args.taskName}`,
    '- 相关仓库：/data1/code/agent-platform-v2',
    '',
    '## 验证状态',
    '- 本文档由 Feishu `/ap handover` 自动生成。',
    '',
    '## Task Room 摘要',
    args.transcript || '(当前没有可用的非系统 task room transcript)',
    '',
  ].join('\n');
}

async function handleHandoverCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法生成 handover。';
  }

  const memberQuery = (command.options['agent'] || command.args.join(' ') || '').trim();
  const member = resolveRoomMemberQuery({ room, query: memberQuery });
  if (!member) {
    return memberQuery
      ? `找不到可交接成员：${memberQuery}`
      : '当前房间没有可交接的 agent 成员。';
  }

  const promptContext = await buildTaskRoomPromptContext(room.sourceTask.id, room.sourceTask.name, 30);
  const title =
    (command.options['title'] || '').trim()
    || `${room.title} ${member.userNickname || member.displayName} handover`;
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `${timestamp}_${sanitizeHandoverSlug(title)}_HANDOVER.md`;
  const relativePath = path.posix.join('docs', fileName);
  const absolutePath = path.join(process.cwd(), relativePath);
  const body = buildHandoverDocBody({
    roomTitle: room.title,
    memberName: member.userNickname || member.displayName,
    taskName: room.sourceTask.name,
    latestUserMessage: promptContext.latestUserMessage?.content || null,
    transcript: promptContext.transcript,
    title,
  });

  await fs.writeFile(absolutePath, body, 'utf8');

  return [
    `✅ 已为 ${member.userNickname || member.displayName} 生成 handover`,
    `文件：${relativePath}`,
    '',
    '下一步可发送：',
    `/ap new --handover="${relativePath}" --profile=full "${member.userNickname || member.displayName}"`,
  ].join('\n');
}

function resolveHandoverPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const relativePath = trimmed.startsWith('docs/') ? trimmed : path.posix.join('docs', trimmed);
  return {
    relativePath,
    absolutePath: path.join(process.cwd(), relativePath),
  };
}

function buildNewSessionPrompt(args: {
  handoverPath?: string | null;
  handoverContent?: string | null;
  latestUserMessage?: string | null;
  transcript?: string | null;
  memberName: string;
  taskName: string;
  blankBootstrap?: boolean;
}) {
  if (args.handoverPath && args.handoverContent) {
    return [
      `Read the handover file at ${args.handoverPath} first.`,
      'Then do exactly these three things:',
      '1. Summarize the current state.',
      '2. Confirm the next step.',
      '3. Continue the work in a fresh session.',
      '',
      'Handover content:',
      args.handoverContent,
    ].join('\n');
  }

  if (args.blankBootstrap) {
    return [
      `Start a fresh blank session for ${args.memberName} on task "${args.taskName}".`,
      'Do not assume prior room/task transcript unless the user provides it again.',
      'Wait for the next user instruction and only act on that new instruction.',
    ].join('\n');
  }

  return [
    `Start a fresh session for ${args.memberName} on task "${args.taskName}".`,
    'There is no explicit handover file for this restart.',
    'Use the current room/task state below as the bootstrap context.',
    'Then do exactly these three things:',
    '1. Summarize the current state.',
    '2. Confirm the next step.',
    '3. Continue the work in a fresh session.',
    '',
    'Latest user message:',
    args.latestUserMessage || '(none)',
    '',
    'Recent task-room transcript:',
    args.transcript || '(no transcript available)',
  ].join('\n');
}

function isTruthyFeishuOption(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

function parseNewSessionProfile(value: string | null | undefined): 'safe_local' | 'dev_local' | 'full_access' | null {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) {
    return null;
  }

  if (['safe', 'safe_local', 'safe-local', 'local'].includes(normalized)) {
    return 'safe_local';
  }

  return parseGrantProfile(normalized);
}

function buildNewSessionPermissionConfig(
  currentPermissionConfig: ReturnType<typeof normalizeAcpxPermissionConfig>,
  requestedProfile: 'safe_local' | 'dev_local' | 'full_access' | null
) {
  if (!requestedProfile) {
    return currentPermissionConfig;
  }

  if (requestedProfile === 'safe_local') {
    return normalizeAcpxPermissionConfig({
      profile: 'safe_local',
      sandboxMode: 'workspace-write',
      networkAccess: 'restricted',
      approvalPolicy: 'never',
      writableRoots: currentPermissionConfig.writableRoots,
    });
  }

  return normalizeAcpxPermissionConfig({
    profile: requestedProfile,
    sandboxMode: requestedProfile === 'full_access' ? 'danger-full-access' : 'workspace-write',
    networkAccess: 'enabled',
    approvalPolicy: 'on-request',
    writableRoots: currentPermissionConfig.writableRoots,
  });
}

function formatPermissionProfileLabel(profile: string) {
  return profile === 'full_access'
    ? 'Full Access'
    : profile === 'dev_local'
    ? 'Dev Local'
    : profile === 'safe_local'
    ? 'Safe Local'
    : profile;
}

async function readRecordedRunPermissionConfig(taskRunId: string) {
  const taskRun = await prisma.taskRun.findUnique({
    where: { id: taskRunId },
    select: { controlMetadata: true },
  });

  if (!taskRun?.controlMetadata) {
    return null;
  }

  try {
    const metadata = JSON.parse(taskRun.controlMetadata) as {
      permissionConfig?: Partial<ReturnType<typeof normalizeAcpxPermissionConfig>>;
    };
    return normalizeAcpxPermissionConfig(metadata.permissionConfig);
  } catch {
    return null;
  }
}

async function handleNewSessionCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法启动 new session。';
  }

  const handoverOption = (command.options['handover'] || command.options['from-handover'] || '').trim();
  const memberQuery = (command.options['agent'] || command.args.join(' ') || '').trim();
  const member = resolveRoomMemberQuery({ room, query: memberQuery });
  if (!member) {
    return memberQuery
      ? `找不到目标成员：${memberQuery}`
      : '当前房间没有可启动 new session 的 agent 成员。';
  }

  const handoverPath = resolveHandoverPath(handoverOption);
  const blankBootstrap =
    isTruthyFeishuOption(command.options['blank'])
    || isTruthyFeishuOption(command.options['no-bootstrap'])
    || isTruthyFeishuOption(command.options['no_bootstrap']);
  let handoverContent: string | null = null;
  if (handoverOption) {
    if (!handoverPath) {
      return 'handover 路径为空。';
    }

    try {
      await fs.access(handoverPath.absolutePath);
    } catch {
      return `找不到 handover 文件：${handoverPath.relativePath}`;
    }

    handoverContent = await fs.readFile(handoverPath.absolutePath, 'utf8');
  }
  const participant = buildLiveRoomAcpxParticipant({
    id: member.id,
    displayName: member.displayName,
    backend: member.backend,
    harnessType: member.harnessType,
    gatewayId: member.backend === 'remote_ssh'
      ? (member.gateway?.id || member.gatewayId)
      : member.gatewayId,
    gatewayName: member.gateway?.name || null,
    runtimeAgentId: member.runtimeAgentId,
  });
  const currentPermissionConfig = (() => {
    try {
      return normalizeAcpxPermissionConfig(
        JSON.parse(room.sourceTask.acpxPermissionConfig || 'null')
      );
    } catch {
      return DEFAULT_ACPX_PERMISSION_CONFIG;
    }
  })();
  const requestedProfile =
    parseNewSessionProfile(command.options['profile'])
    || parseNewSessionProfile(command.options['rights'])
    || parseNewSessionProfile(command.options['permission'])
    || parseNewSessionProfile(command.options['access']);
  const permissionConfig = buildNewSessionPermissionConfig(currentPermissionConfig, requestedProfile);
  let interruptedPreviousReplies = false;

  if (requestedProfile && permissionConfig.profile !== currentPermissionConfig.profile) {
    await prisma.task.update({
      where: { id: room.sourceTask.id },
      data: {
        acpxPermissionConfig: JSON.stringify(permissionConfig),
      },
    });
  }

  const taskRoom = await ensureTaskChatRoom(room.sourceTask.id, room.sourceTask.name);
  const promptContext = blankBootstrap
    ? { transcript: '', latestUserMessage: null }
    : await buildTaskRoomPromptContext(room.sourceTask.id, room.sourceTask.name, 30);
  const prompt = buildNewSessionPrompt({
    handoverPath: handoverPath?.relativePath || null,
    handoverContent,
    latestUserMessage: promptContext.latestUserMessage?.content || null,
    transcript: promptContext.transcript,
    memberName: member.userNickname || member.displayName,
    taskName: room.sourceTask.name,
    blankBootstrap,
  });

  if (member.backend === 'remote_ssh') {
    try {
      const interruption = await interruptLiveRoomMemberReplies({
        roomId: room.id,
        memberId: member.id,
      });
      interruptedPreviousReplies =
        interruption.interruptedRunningCount > 0 || interruption.cancelledQueuedCount > 0;
    } catch (error) {
      console.warn('Failed to interrupt previous live room replies before new session:', error);
    }
  }

  const freshTaskSession = await rotateTaskSession(room.sourceTask.id, {
    taskName: room.sourceTask.name,
    metadata: {
      source: 'feishu_new_session',
      handoverPath: handoverPath?.relativePath || null,
      targetMemberId: member.id,
      targetMemberName: member.userNickname || member.displayName,
    },
  });
  await postTaskRoomSessionResetMarker({
    roomId: taskRoom.id,
    sessionId: freshTaskSession.id,
    reason: `new-session:${member.id}`,
  });
  await prisma.liveRoomMemberSession.updateMany({
    where: {
      roomId: room.id,
      memberId: member.id,
    },
    data: {
      threadId: null,
      status: 'online',
      lastError: 'reset_by_new_session',
      lastHeartbeatAt: new Date(),
    },
  }).catch(() => undefined);
  const targetParticipantKey = getTaskRoomParticipantTargetKey(participant);
  const targetParticipantLabel = getTaskRoomParticipantTargetLabel(participant);
  await postTaskRoomMessage({
    roomId: taskRoom.id,
    content: handoverPath
      ? `[new-session] ${member.userNickname || member.displayName} <- ${handoverPath.relativePath}`
      : blankBootstrap
      ? `[new-session] ${member.userNickname || member.displayName} <- blank bootstrap`
      : `[new-session] ${member.userNickname || member.displayName} <- room-state bootstrap`,
    userId: 'task-room-user',
    userName: '用户',
    targetType: 'participant',
    targetParticipantKey,
    targetParticipantLabel,
  });

  await postTaskRoomMessage({
    roomId: taskRoom.id,
    content: prompt,
    userId: 'task-room-user',
    userName: '用户',
    targetType: 'participant',
    targetParticipantKey,
    targetParticipantLabel,
  });

  const result = await executeAcpxTaskRun({
    taskId: room.sourceTask.id,
    taskSessionId: freshTaskSession.id,
    taskName: room.sourceTask.name,
    taskDescription: room.sourceTask.description || undefined,
    orchestrationMode: 'single',
    workingDirectory: room.sourceTask.workingDirectory || undefined,
    permissionConfig,
    participants: [
      {
        ...participant,
        continuationMessage: undefined,
        resumeSessionId: undefined,
        resumeThreadId: undefined,
        continuationSessionKind: undefined,
        ephemeralSession: false,
      },
    ],
  });
  const recordedPermissionConfig = await readRecordedRunPermissionConfig(result.taskRunId);
  const requestedPermissionLabel = formatPermissionProfileLabel(permissionConfig.profile);
  const recordedPermissionLabel = recordedPermissionConfig
    ? formatPermissionProfileLabel(recordedPermissionConfig.profile)
    : '未知';

  return [
    `✅ 已为 ${member.userNickname || member.displayName} 启动 fresh session`,
    `Bootstrap：${handoverPath?.relativePath ? `handover ${handoverPath.relativePath}` : blankBootstrap ? 'blank' : 'room/task state'}`,
    `请求权限：${requestedPermissionLabel}`,
    `实际落库权限：${recordedPermissionLabel}`,
    ...(recordedPermissionConfig && recordedPermissionConfig.profile !== permissionConfig.profile
      ? [`警告：请求权限与实际落库权限不一致，请检查运行中的 Feishu runtime 是否已重启到最新代码。`]
      : []),
    `Run：${result.taskRunId}`,
    ...(interruptedPreviousReplies ? ['说明：启动新 session 前，已中断该成员旧的 live-room 回复与排队消息。'] : []),
    handoverPath
      ? '说明：本次会以新 session 先读取 handover，再继续执行。'
      : blankBootstrap
      ? '说明：本次会以空白新 session 启动，不注入旧 room/task transcript。'
      : '说明：本次会以新 session 继承当前 room/task 状态继续执行。',
  ].join('\n');
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

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      sourceTask: {
        select: {
          id: true,
          name: true,
          acpxPermissionConfig: true,
        },
      },
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!room || room.members.length === 0) {
    return `Live Room ${roomId} 没有成员。`;
  }

  const members = await serializeLiveRoomMembersWithContext({
    members: room.members,
    sourceTask: room.sourceTask,
  });

  const lines = members.map((m) => {
    const tag = m.memberType === 'user' ? '(you)' : m.presenceStatus;
    const watermark = m.contextWatermark
      ? ` | 用量 ${m.contextWatermark.usagePercentage}% (${m.contextWatermark.dominantLabel}) | 策略 ${m.contextWatermark.policyLabel}`
      : '';
    const permission = m.permissionLabel ? ` | ${m.permissionLabel}` : '';
    return `- ${m.displayName} [${m.id.slice(-8)}] | ${m.backend || 'local'}${permission} | ${tag}${watermark}`;
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

  const agentSelectorValue = command.options['agents'] || command.args.join(',');
  const agentIds = await resolveFeishuSelectedAgentIds(agentSelectorValue);

  if (agentIds.length === 0) {
    return '请指定要添加的 agent。\n示例：/ap add --agents=TX-server:claude\n也支持完整 agent ID。';
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

async function handleWorkspaceCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  const roomId = await getBoundLiveRoomId(context);
  if (!roomId) {
    return '当前 Feishu 会话尚未绑定 Live Room。';
  }

  const newDir = command.args.join(' ').trim() || command.options['path'] || '';
  if (!newDir) {
    const rows = await prisma.$queryRaw<Array<{ workingDirectory: string | null }>>`
      SELECT "workingDirectory"
      FROM "LiveRoom"
      WHERE "id" = ${roomId}
      LIMIT 1
    `;
    return `当前工作目录：${rows[0]?.workingDirectory || process.cwd()}\n如需修改：/ap workspace /your/path`;
  }

  await prisma.$executeRaw`
    UPDATE "LiveRoom"
    SET "workingDirectory" = ${newDir}
    WHERE "id" = ${roomId}
  `;
  const room = await prisma.liveRoom.findUnique({ where: { id: roomId }, select: { sourceTaskId: true } });
  if (room?.sourceTaskId) {
    await prisma.task.update({ where: { id: room.sourceTaskId }, data: { workingDirectory: newDir } });
  }

  return `✅ 工作目录已更新为：${newDir}`;
}

async function handleRoomCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext
) {
  if (!context) {
    return '当前 room 命令需要来自 Feishu webhook 的会话上下文。';
  }

  const selectedAgentIds = await resolveFeishuSelectedAgentIds(command.options['agents']);
  const effectiveAgentIds = selectedAgentIds.length > 0
    ? selectedAgentIds
    : await resolveDefaultFeishuBindingAgentIds();
  const title = command.args.join(' ').trim() || command.options['title'];
  const requestedProfile =
    parseNewSessionProfile(command.options['profile'])
    || parseNewSessionProfile(command.options['rights'])
    || parseNewSessionProfile(command.options['permission'])
    || parseNewSessionProfile(command.options['access']);
  const permissionConfig = requestedProfile
    ? buildAcpxPermissionConfigForProfile(requestedProfile, [])
    : undefined;
  const result = await ensureFeishuConversationBinding({
    context,
    selectedAgentIds: effectiveAgentIds,
    title,
    topic: command.options['topic'],
    workingDirectory: command.options['workdir'] || undefined,
    permissionConfig,
  });

  return [
    result.created ? '已创建 Feishu 绑定房间。' : '已复用现有 Feishu 绑定房间。',
    `Live Room: ${result.roomTitle} (${result.liveRoomId})`,
    `新增成员数：${result.addedAgentCount}`,
    `权限：${permissionConfig ? formatPermissionProfileLabel(permissionConfig.profile) : 'Safe Local（默认）'}`,
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
    case 'grant':
      return handleGrantCommand(args.command, args.context);
    case 'rights':
      return handleRightsCommand(args);
    case 'handover':
      return handleHandoverCommand(args.command, args.context);
    case 'workspace':
      return handleWorkspaceCommand(args.command, args.context);
    case 'new-session':
      return handleNewSessionCommand(args.command, args.context);
    default:
      return DEFAULT_HELP_TEXT;
  }
}
