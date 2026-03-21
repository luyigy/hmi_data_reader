import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateGatewayToken } from '@/lib/gateway-auth';

function normalizeGatewayUrl(ip?: string, port?: string | number): string | null {
  if (!ip) {
    return null;
  }

  const trimmedIp = String(ip).trim();
  if (!trimmedIp) {
    return null;
  }

  if (trimmedIp.startsWith('http://') || trimmedIp.startsWith('https://')) {
    if (port && !trimmedIp.match(/:\d+(\/|$)/)) {
      return trimmedIp.endsWith('/')
        ? trimmedIp.slice(0, -1) + `:${port}`
        : `${trimmedIp}:${port}`;
    }
    return trimmedIp;
  }

  return port ? `http://${trimmedIp}:${port}` : `http://${trimmedIp}`;
}

function resolveRuntimeAgentId(
  gatewayId: string,
  agentData: Record<string, unknown>
): string | null {
  const candidates = [
    agentData.runtimeAgentId,
    agentData.openclawAgentId,
    agentData.acpAgentId,
    agentData.agentId,
    agentData.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const value = candidate.trim();
      if (!value.startsWith(`${gatewayId}:`)) {
        return value;
      }
    }
  }

  return null;
}

/**
 * POST /api/gateways/register
 *
 * 远程网关自动注册端点
 *
 * 使用场景：
 * 1. 远程 OpenClaw 实例启动时主动注册
 * 2. 定期心跳续期
 * 3. 下线时主动注销
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      action,
      gatewayId,
      name,
      ip,
      port,
      agents,
      resources,
    } = body;

    if (!action || !gatewayId) {
      return NextResponse.json(
        { error: 'Missing required fields: action, gatewayId' },
        { status: 400 }
      );
    }

    const auth = await validateGatewayToken(request);
    if (!auth.authenticated || !auth.gateway) {
      return NextResponse.json(
        { error: auth.error || 'Authentication required' },
        { status: 401 }
      );
    }

    if (auth.gateway.id !== gatewayId) {
      return NextResponse.json(
        { error: 'Gateway token does not match gatewayId' },
        { status: 403 }
      );
    }

    const gatewayUrl = normalizeGatewayUrl(ip, port);

    switch (action) {
      case 'register': {
        const gateway = await prisma.gateway.upsert({
          where: {
            id: gatewayId,
          },
          update: {
            name: name || auth.gateway.name,
            url: gatewayUrl,
            ip: ip ? String(ip) : null,
            resources: resources ? JSON.stringify(resources) : null,
            status: 'online',
            updatedAt: new Date(),
          },
          create: {
            id: gatewayId,
            name: name || auth.gateway.name,
            url: gatewayUrl,
            ip: ip ? String(ip) : null,
            resources: resources ? JSON.stringify(resources) : null,
            status: 'online',
          },
        });

        if (agents && Array.isArray(agents)) {
          for (const agentData of agents) {
            await prisma.agent.upsert({
              where: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
              },
              update: {
                name: agentData.name,
                runtimeAgentId: resolveRuntimeAgentId(gatewayId, agentData),
                type: agentData.type,
                location: 'remote',
                capabilities: JSON.stringify(agentData.capabilities || []),
                status: agentData.status || 'online',
                gatewayId: gateway.id,
                lastHeartbeat: new Date(),
              } as never,
              create: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
                name: agentData.name,
                runtimeAgentId: resolveRuntimeAgentId(gatewayId, agentData),
                type: agentData.type,
                location: 'remote',
                capabilities: JSON.stringify(agentData.capabilities || []),
                status: agentData.status || 'online',
                gatewayId: gateway.id,
              } as never,
            });
          }
        }

        return NextResponse.json({
          success: true,
          gateway,
          message: 'Gateway and agents registered successfully',
        });
      }

      case 'heartbeat': {
        const gateway = await prisma.gateway.update({
          where: { id: gatewayId },
          data: {
            status: 'online',
            ...(gatewayUrl ? { url: gatewayUrl } : {}),
            ...(ip ? { ip: String(ip) } : {}),
            updatedAt: new Date(),
          },
        });

        if (agents && Array.isArray(agents)) {
          for (const agentData of agents) {
            await prisma.agent.upsert({
              where: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
              },
              update: {
                name: agentData.name,
                runtimeAgentId: resolveRuntimeAgentId(gatewayId, agentData),
                type: agentData.type,
                location: 'remote',
                capabilities: JSON.stringify(agentData.capabilities || []),
                status: agentData.status || 'online',
                gatewayId: gatewayId,
                lastHeartbeat: new Date(),
              } as never,
              create: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
                name: agentData.name,
                runtimeAgentId: resolveRuntimeAgentId(gatewayId, agentData),
                type: agentData.type,
                location: 'remote',
                capabilities: JSON.stringify(agentData.capabilities || []),
                status: agentData.status || 'online',
                gatewayId: gatewayId,
              } as never,
            });
          }
        }

        return NextResponse.json({
          success: true,
          message: 'Heartbeat received',
          gateway,
        });
      }

      case 'unregister': {
        await prisma.gateway.update({
          where: { id: gatewayId },
          data: {
            status: 'offline',
            updatedAt: new Date(),
          },
        });

        await prisma.agent.updateMany({
          where: { gatewayId },
          data: {
            status: 'offline',
          },
        });

        return NextResponse.json({
          success: true,
          message: 'Gateway unregistered',
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Failed to register gateway:', error);
    return NextResponse.json(
      { error: 'Failed to register gateway' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/gateways/register
 *
 * 获取注册说明
 */
export async function GET() {
  return NextResponse.json({
    description: 'Remote gateway auto-registration endpoint',
    auth: {
      required: true,
      headers: ['Authorization: Bearer <token>', 'X-Gateway-Token: <token>'],
      note: 'token must belong to the same gatewayId in the request body',
    },
    usage: {
      register: {
        method: 'POST',
        body: {
          action: 'register',
          gatewayId: 'unique-gateway-id',
          name: 'My Gateway',
          ip: '10.0.8.3',
          port: 8080,
          agents: [
            {
              name: 'Coder Agent',
              runtimeAgentId: 'codex',
              type: 'coding',
              capabilities: ['python', 'typescript'],
              status: 'online',
            },
          ],
          resources: {
            cpu: '8 cores',
            memory: '16GB',
          },
        },
      },
      heartbeat: {
        method: 'POST',
        body: {
          action: 'heartbeat',
          gatewayId: 'unique-gateway-id',
          ip: '10.0.8.3',
          port: 8080,
          agents: [
            {
              name: 'Agent 1',
              runtimeAgentId: 'main',
              type: 'coding',
              capabilities: ['typescript'],
              status: 'online',
            },
          ],
        },
        interval: '每 30 秒',
      },
      unregister: {
        method: 'POST',
        body: {
          action: 'unregister',
          gatewayId: 'unique-gateway-id',
        },
      },
    },
  });
}
