import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateGatewayToken } from '@/lib/gateway-auth';
import { decryptToken } from '@/lib/encryption';

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * POST /api/gateways/[id]/test
 * 
 * 测试 Gateway 连接是否通畅
 * 
 * 需要 Token 认证
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 验证 Token
    const auth = await validateGatewayToken(request);
    
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || 'Authentication required' },
        { status: 401 }
      );
    }

    const gatewayId = params.id;

    // 验证 Gateway 是否存在
    const gateway = await prisma.gateway.findUnique({
      where: { id: gatewayId },
    });

    if (!gateway) {
      return NextResponse.json(
        { error: 'Gateway not found' },
        { status: 404 }
      );
    }

    // 测试连接：尝试访问 Gateway URL
    let connectionStatus = 'unknown';
    let responseTime = -1;
    let errorMessage: string | null = null;
    let checkedPath: string | null = null;

    if (gateway.url) {
      try {
        // 如果数据库中保存了加密 token，解密后发送给远端 Gateway
        const authHeaders: Record<string, string> = {};
        if (gateway.token) {
          try {
            const raw = decryptToken(gateway.token);
            authHeaders['Authorization'] = `Bearer ${raw}`;
          } catch (err) {
            // 如果解密失败，仍然继续但记录错误
            console.warn('Failed to decrypt gateway token for testing:', err);
          }
        }

        // OpenClaw 默认健康检查是 /health；保留 /api/health 兼容平台自有实例
        const healthPaths = ['/health', '/healthz', '/api/health'];
        let lastHttpError: string | null = null;

        for (const healthPath of healthPaths) {
          const startTime = Date.now();
          const testUrl = joinUrl(gateway.url, healthPath);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          try {
            const response = await fetch(testUrl, {
              method: 'GET',
              headers: authHeaders,
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.ok) {
              checkedPath = healthPath;
              responseTime = Date.now() - startTime;
              connectionStatus = 'connected';
              errorMessage = null;

              await prisma.gateway.update({
                where: { id: gatewayId },
                data: {
                  status: 'online',
                  updatedAt: new Date(),
                },
              });
              break;
            }

            lastHttpError = `HTTP ${response.status} (${healthPath})`;
          } catch (error) {
            clearTimeout(timeoutId);
            lastHttpError = error instanceof Error ? error.message : 'Unknown error';
          }
        }

        if (connectionStatus !== 'connected') {
          connectionStatus = 'unreachable';
          errorMessage = lastHttpError || 'Gateway health probe failed';
        }
      } catch (error) {
        connectionStatus = 'unreachable';
        errorMessage = error instanceof Error ? error.message : 'Unknown error';
      }
    } else {
      connectionStatus = 'no-url';
      errorMessage = 'Gateway URL not configured';
    }

    return NextResponse.json({
      success: true,
      gateway: {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        status: gateway.status,
      },
      connection: {
        status: connectionStatus,
        responseTime,
        checkedPath,
        error: errorMessage,
        testedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Failed to test gateway connection:', error);
    return NextResponse.json(
      { error: 'Failed to test gateway connection' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/gateways/[id]/test
 * 
 * 获取 Gateway 连接状态（不需要实际测试）
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const gateway = await prisma.gateway.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        url: true,
        status: true,
        token: true,
        updatedAt: true,
      },
    });

    if (!gateway) {
      return NextResponse.json(
        { error: 'Gateway not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      gateway: {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        status: gateway.status,
        hasToken: !!gateway.token,
        lastUpdated: gateway.updatedAt,
      },
    });
  } catch (error) {
    console.error('Failed to fetch gateway status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch gateway status' },
      { status: 500 }
    );
  }
}
