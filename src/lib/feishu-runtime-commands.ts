import { prisma } from '@/lib/prisma';
import { getRealAgentsStatus } from '@/lib/real-agents';
import { ensurePlatformLocalAgents, getServerHostname } from '@/lib/platform-local-init';
import { readFeishuRuntimeStatus } from '@/lib/feishu-runtime-status';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { listLiveRoomCatalogAgents } from '@/lib/live-room';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { getBoundLiveRoom, resolveRoomMemberQuery, type FeishuConversationContext } from '@/lib/feishu-live-room';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import { readCodexQuotaCache } from '@/lib/codex-telemetry';
import { resolvePlatformLocalCodexHome } from '@/lib/real-agents/codex-home';

function getLocalHarnessStatus(agentName: string, localStatus: Awaited<ReturnType<typeof getRealAgentsStatus>>) {
  const normalized = agentName.trim().toLowerCase();
  if (normalized.includes('antigravity') || normalized === 'agy') {
    return localStatus.antigravity.available ? 'online' : 'offline';
  }
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
  if (normalized.includes('kimi-code') || normalized === 'kimi') {
    return localStatus['kimi-code'].available ? 'online' : 'offline';
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

const formatQuotaWindow = (label: string, window: {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}) => `${label}: used ${window.usedPercent}% | window ${window.windowDurationMins}m | reset ${new Date(window.resetsAt * 1000).toISOString()}`;

const handleCodexQuotaStatus = async (
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext
) => {
  if (!isFeishuAdmin(context?.senderOpenId)) {
    return '仅配置的 Feishu 管理员可以查看 Codex quota。';
  }
  const room = await getBoundLiveRoom(context);
  if (!room) return '当前 Feishu 会话尚未绑定 Live Room。';
  const member = resolveRoomMemberQuery({
    room,
    query: command.options.agent || command.args.find((arg) => arg !== 'quota'),
  });
  if (!member || member.backend !== 'platform_local' || member.harnessType !== 'codex') {
    return '请选择当前房间中的 Platform Local Codex 成员：/ap status --quota --agent=<成员>';
  }
  const permission = resolveLiveRoomMemberPermission(
    member.acpxPermissionConfig,
    room.sourceTask?.acpxPermissionConfig
  );
  const workspaceRoot = permission.profile === 'full_access'
    ? undefined
    : permission.writableRoots[0] || room.sourceTask?.workingDirectory || process.cwd();
  const codexHome = resolvePlatformLocalCodexHome(
    workspaceRoot,
    `/data1/.agent-platform/codex-rooms/${room.id}`
  );
  const quota = readCodexQuotaCache(codexHome);
  if (!quota) return '当前 Codex 账户暂无新鲜 quota snapshot；请在该成员下一次 App Server 运行后重试。';
  const windows = [
    quota.primary ? formatQuotaWindow('primary', quota.primary) : null,
    quota.secondary ? formatQuotaWindow('secondary', quota.secondary) : null,
  ].filter((line): line is string => Boolean(line));
  return [
    'Codex quota（管理员诊断）',
    ...(windows.length ? windows : ['No quota windows reported.']),
    `collected ${quota.collectedAt}`,
  ].join('\n');
};

export async function handleStatusCommand(
  command?: ParsedFeishuCommand,
  context?: FeishuConversationContext
) {
  if (command && (command.options.quota === 'true' || command.args.includes('quota'))) {
    return handleCodexQuotaStatus(command, context);
  }
  const [gatewayCount, onlineGatewayCount, agentCount, onlineAgentCount, sessionCount] =
    await Promise.all([
      prisma.gateway.count(),
      prisma.gateway.count({ where: { status: 'online' } }),
      prisma.agent.count(),
      prisma.agent.count({ where: { status: 'online' } }),
      prisma.crossGatewayChatSession.count().catch(() => 0),
    ]);
  const runtime = readFeishuRuntimeStatus();
  const runtimeLines = runtime?.metrics
    ? [
        `飞书运行时：${runtime.metrics.health === 'healthy' ? '健康' : runtime.metrics.health}（PID ${runtime.pid}）`,
        `线程数：${runtime.metrics.threads}`,
        `文件描述符：${runtime.metrics.openFileDescriptors}`,
        `SQLite 描述符：${runtime.metrics.sqliteFileDescriptors}`,
        `内存占用：${runtime.metrics.rssMb} MB`,
      ]
    : [`飞书运行时：${runtime?.status ?? '不可用'}（暂无指标）`];

  return [
    'Agent Platform 状态',
    `网关：${onlineGatewayCount}/${gatewayCount} 在线`,
    `Agent：${onlineAgentCount}/${agentCount} 在线`,
    `跨网关会话：${sessionCount}`,
    '',
    ...runtimeLines,
  ].join('\n');
}

export async function handleGatewaysCommand() {
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

export async function handleAgentsCommand(command: ParsedFeishuCommand) {
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
      const catalogId = catalog?.backend === 'platform_local'
        ? `local:${catalog.harnessType}`
        : catalog?.id ?? `platform_local:${gatewayLabel}:${agent.type || agent.name}`;
      const nickname = agent.userNickname ? ` "${agent.userNickname}"` : '';
      return `- ${agent.name}${nickname} | ${status}\n  --agents=${catalogId}`;
    }),
  ].join('\n');
}

export async function handleHostsCommand() {
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

export async function handleRunCommand(command: ParsedFeishuCommand) {
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

export async function handleRegisterCommand(command: ParsedFeishuCommand) {
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
