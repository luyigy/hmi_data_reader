import { decryptToken } from '@/lib/encryption';
import { prisma } from '@/lib/prisma';

process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

const WebSocket: {
  new (url: string, options?: { headers?: Record<string, string> }): {
    send(data: string): void;
    close(): void;
    terminate(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
} = require('ws');

const OPENCLAW_PROTOCOL_VERSION = 3;
const REQUEST_TIMEOUT_MS = 12000;

interface OpenClawAgentListEntry {
  id: string;
  name?: string;
}

interface OpenClawAgentListResponse {
  defaultId?: string;
  mainKey?: string;
  scope?: string;
  agents?: OpenClawAgentListEntry[];
}

function toWebSocketUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/i, 'ws').replace(/\/$/, '') + '/v1';
}

function normalizeRuntimeAgentId(agent: OpenClawAgentListEntry): string {
  return agent.id.trim();
}

function normalizeAgentName(agent: OpenClawAgentListEntry): string {
  return (agent.name || agent.id).trim();
}

export async function fetchGatewayAgents(
  gatewayId: string,
  platformOrigin: string
): Promise<OpenClawAgentListEntry[]> {
  const gateway = await prisma.gateway.findUnique({
    where: { id: gatewayId },
    select: {
      id: true,
      name: true,
      url: true,
      openclawToken: true,
    },
  });

  if (!gateway) {
    throw new Error('Gateway 不存在');
  }

  if (!gateway.url || !gateway.openclawToken) {
    throw new Error('Gateway 尚未配置 OpenClaw URL 或 token');
  }

  const token = decryptToken(gateway.openclawToken);
  const wsUrl = toWebSocketUrl(gateway.url);

  return await new Promise<OpenClawAgentListEntry[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { origin: platformOrigin },
    });

    let reqId = 1;
    const pending = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
      }
    >();

    const cleanup = () => {
      clearTimeout(timer);
      pending.forEach((task) => {
        task.reject(new Error('Gateway 连接已关闭'));
      });
      pending.clear();
    };

    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error('读取 Gateway agents 超时'));
    }, REQUEST_TIMEOUT_MS);

    const send = <T>(method: string, params: Record<string, unknown>) =>
      new Promise<T>((resolveRequest, rejectRequest) => {
        const id = String(reqId++);
        pending.set(id, {
          resolve: resolveRequest as (value: unknown) => void,
          reject: rejectRequest,
        });
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      });

    ws.on('error', (error: unknown) => {
      cleanup();
      reject(new Error(`Gateway WS 连接失败: ${String(error)}`));
    });

    ws.on('close', () => {
      cleanup();
    });

    ws.on('message', async (...args: unknown[]) => {
      const raw = String(args[0]);
      let msg: {
        type?: string;
        id?: string;
        ok?: boolean;
        event?: string;
        payload?: unknown;
        error?: { message?: string; details?: unknown };
      };

      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'res' && msg.id) {
        const task = pending.get(String(msg.id));
        if (!task) {
          return;
        }

        pending.delete(String(msg.id));
        if (msg.ok) {
          task.resolve(msg.payload);
        } else {
          task.reject(
            new Error(
              msg.error?.message || 'Gateway RPC 请求失败'
            )
          );
        }
        return;
      }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        try {
          await send('connect', {
            minProtocol: OPENCLAW_PROTOCOL_VERSION,
            maxProtocol: OPENCLAW_PROTOCOL_VERSION,
            client: {
              id: 'openclaw-control-ui',
              version: '1.0.0',
              platform: 'web',
              mode: 'webchat',
              instanceId: 'agent-platform-v2',
            },
            caps: [],
            commands: [],
            role: 'operator',
            scopes: [
              'operator.admin',
              'operator.read',
              'operator.write',
              'operator.approvals',
              'operator.pairing',
            ],
            auth: { token },
          });

          const agentResult = await send<OpenClawAgentListResponse>('agents.list', {});
          clearTimeout(timer);
          ws.close();
          resolve(Array.isArray(agentResult?.agents) ? agentResult.agents : []);
        } catch (error) {
          cleanup();
          ws.close();
          reject(
            error instanceof Error
              ? error
              : new Error('读取 Gateway agents 失败')
          );
        }
      }
    });
  });
}

export async function syncGatewayAgents(
  gatewayId: string,
  platformOrigin: string
) {
  const gateway = await prisma.gateway.findUnique({
    where: { id: gatewayId },
    select: { id: true },
  });

  if (!gateway) {
    throw new Error('Gateway 不存在');
  }

  const remoteAgents = await fetchGatewayAgents(gatewayId, platformOrigin);
  const activeRuntimeIds = new Set(
    remoteAgents.map((agent) => normalizeRuntimeAgentId(agent))
  );

  await prisma.agent.updateMany({
    where: {
      gatewayId,
      location: 'remote',
      runtimeAgentId: {
        not: null,
      },
    },
    data: {
      status: 'offline',
    },
  });

  for (const remoteAgent of remoteAgents) {
    const runtimeAgentId = normalizeRuntimeAgentId(remoteAgent);
    const name = normalizeAgentName(remoteAgent);
    const id = `${gatewayId}:${runtimeAgentId}`;

    await prisma.agent.upsert({
      where: { id },
      update: {
        name,
        runtimeAgentId,
        type: 'openclaw',
        location: 'remote',
        capabilities: JSON.stringify([]),
        status: 'online',
        gatewayId,
        lastHeartbeat: new Date(),
      } as never,
      create: {
        id,
        name,
        runtimeAgentId,
        type: 'openclaw',
        location: 'remote',
        capabilities: JSON.stringify([]),
        status: 'online',
        gatewayId,
      } as never,
    });
  }

  const agents = await prisma.agent.findMany({
    where: {
      gatewayId,
      OR: [
        { runtimeAgentId: { in: Array.from(activeRuntimeIds) } },
        { id: { in: Array.from(activeRuntimeIds).map((runtimeAgentId) => `${gatewayId}:${runtimeAgentId}`) } },
      ],
    },
    select: {
      id: true,
      name: true,
      runtimeAgentId: true,
      type: true,
      status: true,
    },
    orderBy: {
      name: 'asc',
    },
  });

  return {
    gatewayId,
    count: agents.length,
    agents,
  };
}
