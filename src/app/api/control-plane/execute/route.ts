/**
 * POST /api/control-plane/execute
 * 
 * 执行命令到 Control Plane
 */

import { NextRequest, NextResponse } from 'next/server';
import { GatewayManager } from '@/lib/control-plane/GatewayManager';
import { validateGatewayToken } from '@/lib/gateway-auth';

// 单例 GatewayManager
const globalForControlPlane = globalThis as unknown as {
  gatewayManager?: GatewayManager;
};

const getGatewayManager = () => {
  if (!globalForControlPlane.gatewayManager) {
    globalForControlPlane.gatewayManager = new GatewayManager();
  }
  return globalForControlPlane.gatewayManager;
};

export async function POST(request: NextRequest) {
  try {
    // 验证认证（可选，取决于安全需求）
    // const auth = await validateGatewayToken(request);
    // if (!auth.authenticated) {
    //   return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    // }

    const body = await request.json();
    const { command, gatewayId, task } = body;

    if (!command) {
      return NextResponse.json(
        { error: 'Missing required field: command' },
        { status: 400 }
      );
    }

    const manager = getGatewayManager();

    // 执行命令
    switch (command) {
      case 'assign': {
        if (!task) {
          return NextResponse.json(
            { error: 'Missing required field: task' },
            { status: 400 }
          );
        }

        const result = await manager.assignTask(task);
        return NextResponse.json(result);
      }

      case 'broadcast': {
        if (!task) {
          return NextResponse.json(
            { error: 'Missing required field: task' },
            { status: 400 }
          );
        }

        const result = await manager.broadcastTask(task);
        return NextResponse.json(result);
      }

      case 'select': {
        const criteria = body.criteria || {};
        const gateway = await manager.selectBestGateway(criteria);
        return NextResponse.json({ gatewayId: gateway });
      }

      case 'status': {
        const gateways = await manager.getAllGateways();
        return NextResponse.json({ gateways });
      }

      default:
        return NextResponse.json(
          { error: `Unknown command: ${command}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Failed to execute control plane command:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Command execution failed' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const manager = getGatewayManager();
    const gateways = await manager.getAllGateways();
    return NextResponse.json({ gateways });
  } catch (error) {
    console.error('Failed to fetch gateways:', error);
    return NextResponse.json(
      { error: 'Failed to fetch gateways' },
      { status: 500 }
    );
  }
}
