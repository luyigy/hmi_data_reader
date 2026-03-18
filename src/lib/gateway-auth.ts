import { prisma } from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { decryptToken } from '@/lib/encryption';
import crypto from 'crypto';

export interface GatewayAuthResult {
  authenticated: boolean;
  gateway?: {
    id: string;
    name: string;
    url?: string | null;
    status: string;
  };
  error?: string;
}

/**
 * 从请求中提取并验证 Gateway Token
 * 
 * 支持两种认证方式:
 * 1. Authorization: Bearer <token>
 * 2. X-Gateway-Token: <token>
 */
export async function validateGatewayToken(
  request: NextRequest
): Promise<GatewayAuthResult> {
  try {
    // 尝试从 Authorization header 获取 token
    const authHeader = request.headers.get('authorization');
    let token: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      // 尝试从 X-Gateway-Token header 获取
      token = request.headers.get('x-gateway-token');
    }

    if (!token) {
      return {
        authenticated: false,
        error: 'Missing authentication token',
      };
    }

    // 查找所有有 Token 的 Gateway
    const gateways = await prisma.gateway.findMany({
      where: {
        token: {
          not: null,
        },
      },
      select: {
        id: true,
        name: true,
        url: true,
        status: true,
        token: true,
      },
    });

    // 解密并比对每个 Token
    for (const gateway of gateways) {
      try {
        if (!gateway.token) continue;
        
        const decryptedToken = decryptToken(gateway.token);
        
        if (decryptedToken === token) {
          return {
            authenticated: true,
            gateway: {
              id: gateway.id,
              name: gateway.name,
              url: gateway.url,
              status: gateway.status,
            },
          };
        }
      } catch {
        // 解密失败，跳过此 Gateway
        continue;
      }
    }

    return {
      authenticated: false,
      error: 'Invalid token',
    };
  } catch (error) {
    console.error('Failed to validate gateway token:', error);
    return {
      authenticated: false,
      error: 'Authentication failed',
    };
  }
}

/**
 * 创建一个需要 Gateway 认证的 API 处理器
 * 
 * 用法:
 * export const POST = withGatewayAuth(async (request, gateway) => {
 *   // 已认证的 gateway 对象可用
 *   return NextResponse.json({ ok: true });
 * });
 */
export function withGatewayAuth<T extends NextRequest>(
  handler: (request: T, gateway: GatewayAuthResult['gateway']) => Promise<NextResponse>
) {
  return async (request: T) => {
    const auth = await validateGatewayToken(request);

    if (!auth.authenticated || !auth.gateway) {
      return NextResponse.json(
        { error: auth.error || 'Authentication required' },
        { status: 401 }
      );
    }

    return handler(request, auth.gateway);
  };
}

/**
 * 生成安全的 Gateway Token
 */
export function generateGatewayToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
