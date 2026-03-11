import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * POST /api/nodes/register
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
      action,           // 'register' | 'heartbeat' | 'unregister'
      gatewayId,        // 远程网关唯一标识（从远程 openclaw.json 读取）
      name,             // 网关名称
      ip,               // 网关地址（自动上报）
      port,             // 网关端口
      agents,           // 该网关上的 Agent 列表
      resources,        // 资源信息
    } = body;

    // 验证必要字段
    if (!action || !gatewayId) {
      return NextResponse.json(
        { error: 'Missing required fields: action, gatewayId' },
        { status: 400 }
      );
    }

    // 根据 action 处理
    switch (action) {
      case 'register': {
        // 创建或更新 Node
        const node = await prisma.node.upsert({
          where: {
            id: gatewayId,
          },
          update: {
            name,
            ip: `${ip}:${port}`,
            resources: resources ? JSON.stringify(resources) : null,
            status: 'online',
            updatedAt: new Date(),
          },
          create: {
            id: gatewayId,
            name,
            ip: `${ip}:${port}`,
            resources: resources ? JSON.stringify(resources) : null,
            status: 'online',
          },
        });

        // 同步注册 Agents
        if (agents && Array.isArray(agents)) {
          for (const agentData of agents) {
            await prisma.agent.upsert({
              where: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
              },
              update: {
                name: agentData.name,
                type: agentData.type,
                location: 'remote',
                capabilities: JSON.stringify(agentData.capabilities || []),
                status: agentData.status || 'online',
                nodeId: node.id,
                lastHeartbeat: new Date(),
              },
              create: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
                name: agentData.name,
                type: agentData.type,
                location: 'remote',
                capabilities: JSON.stringify(agentData.capabilities || []),
                status: agentData.status || 'online',
                nodeId: node.id,
              },
            });
          }
        }

        return NextResponse.json({
          success: true,
          node,
          message: 'Node and agents registered successfully',
        });
      }

      case 'heartbeat': {
        // 更新心跳
        const node = await prisma.node.update({
          where: { id: gatewayId },
          data: {
            status: 'online',
            updatedAt: new Date(),
          },
        });

        // 同步更新 agents 状态
        if (agents && Array.isArray(agents)) {
          for (const agentData of agents) {
            await prisma.agent.update({
              where: {
                id: agentData.id || `${gatewayId}:${agentData.name}`,
              },
              data: {
                status: agentData.status || 'online',
                lastHeartbeat: new Date(),
              },
            });
          }
        }

        return NextResponse.json({
          success: true,
          message: 'Heartbeat received',
          node,
        });
      }

      case 'unregister': {
        // 标记为离线
        await prisma.node.update({
          where: { id: gatewayId },
          data: {
            status: 'offline',
            updatedAt: new Date(),
          },
        });

        // 将所有关联 agent 设为离线
        await prisma.agent.updateMany({
          where: { nodeId: gatewayId },
          data: {
            status: 'offline',
          },
        });

        return NextResponse.json({
          success: true,
          message: 'Node unregistered',
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Failed to register node:', error);
    return NextResponse.json(
      { error: 'Failed to register node' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/nodes/register
 * 
 * 获取注册说明
 */
export async function GET() {
  return NextResponse.json({
    description: 'Remote gateway auto-registration endpoint',
    usage: {
      register: {
        method: 'POST',
        body: {
          action: 'register',
          gatewayId: 'unique-gateway-id',
          name: 'My Gateway',
          ip: '192.168.1.100',
          port: 8080,
          agents: [
            {
              name: 'Coder Agent',
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
          agents: [...], // 当前 agent 状态
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
