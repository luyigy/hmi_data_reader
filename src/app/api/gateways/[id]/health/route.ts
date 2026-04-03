import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/gateways/[id]/health
 * 
 * 获取指定 Gateway 的健康状态
 * 返回：
 * - success: 健康检查是否成功
 * - latencyMs: 响应延迟（毫秒）
 * - statusCode: HTTP 状态码
 * - lastChecked: 最后检查时间
 * - gatewayInfo: Gateway 基本信息
 * - resources: 资源使用情况（可选）
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const gatewayId = params.id;
  const startTime = Date.now();

  try {
    // 从数据库获取 Gateway 信息
    const gateway = await prisma.gateway.findUnique({
      where: { id: gatewayId },
      include: {
        agents: true,
      },
    });

    if (!gateway) {
      return NextResponse.json(
        {
          success: false,
          error: 'Gateway not found',
          latencyMs: 0,
          statusCode: 404,
          lastChecked: new Date().toISOString(),
        },
        { status: 404 }
      );
    }

    // 尝试连接 Gateway 进行健康检查
    let healthCheckResult: {
      success: boolean;
      latencyMs: number;
      statusCode: number;
      gatewayInfo?: any;
      resources?: any;
    };

    try {
      // 发送健康检查请求到 Gateway
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 秒超时

      const healthUrl = `${gateway.url}/health`;
      const healthResponse = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${gateway.token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;
      const statusCode = healthResponse.status;

      if (healthResponse.ok) {
        const data = await healthResponse.json();
        healthCheckResult = {
          success: true,
          latencyMs,
          statusCode,
          gatewayInfo: data,
          resources: data.resources,
        };

        // 更新数据库中的状态
        await prisma.controlPlaneState.upsert({
          where: { gatewayId },
          create: {
            gatewayId,
            status: 'online',
            lastHeartbeat: new Date(),
            latency: latencyMs,
            consecutiveFails: 0,
            loadScore: calculateLoadScore(data.resources),
          },
          update: {
            status: 'online',
            lastHeartbeat: new Date(),
            latency: latencyMs,
            consecutiveFails: 0,
            loadScore: calculateLoadScore(data.resources),
          },
        });
      } else {
        healthCheckResult = {
          success: false,
          latencyMs,
          statusCode,
        };

        // 更新数据库状态为 unhealthy
        await prisma.controlPlaneState.upsert({
          where: { gatewayId },
          create: {
            gatewayId,
            status: 'unhealthy',
            lastHeartbeat: new Date(),
            latency: latencyMs,
            consecutiveFails: 1,
            loadScore: 0,
          },
          update: {
            status: 'unhealthy',
            lastHeartbeat: new Date(),
            latency: latencyMs,
            consecutiveFails: { increment: 1 },
          },
        });
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      
      healthCheckResult = {
        success: false,
        latencyMs,
        statusCode: 0,
      };

      // 更新数据库状态为 offline
      await prisma.controlPlaneState.upsert({
        where: { gatewayId },
        create: {
          gatewayId,
          status: 'offline',
          lastHeartbeat: new Date(),
          latency: 0,
          consecutiveFails: 1,
          loadScore: 0,
        },
        update: {
          status: 'offline',
          lastHeartbeat: new Date(),
          consecutiveFails: { increment: 1 },
        },
      });
    }

    // 获取最新的控制平面状态
    const controlPlaneState = await prisma.controlPlaneState.findUnique({
      where: { gatewayId },
    });

    // 构建响应
    const response = {
      success: healthCheckResult.success,
      latencyMs: healthCheckResult.latencyMs,
      statusCode: healthCheckResult.statusCode,
      lastChecked: new Date().toISOString(),
      gatewayInfo: {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        status: controlPlaneState?.status || gateway.status || 'unknown',
      },
      resources: healthCheckResult.resources,
      agents: gateway.agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error(`[Gateway Health] Error checking gateway ${gatewayId}:`, error);
    
    const latencyMs = Date.now() - startTime;
    
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
        latencyMs,
        statusCode: 500,
        lastChecked: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

/**
 * 计算负载分数（0-100，越低越好）
 */
function calculateLoadScore(resources?: any): number {
  if (!resources) {
    return 0;
  }

  const cpu = resources.cpu ?? 0;
  const memory = resources.memory ?? 0;
  const disk = resources.disk ?? 0;

  // 简单加权平均
  const score = (cpu * 0.4 + memory * 0.4 + disk * 0.2);
  
  return Math.min(Math.round(score), 100);
}
