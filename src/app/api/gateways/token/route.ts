import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import { encryptToken, decryptToken } from '@/lib/encryption';

/**
 * POST /api/gateways/token
 *
 * 为指定 Gateway 生成或刷新认证 Token
 *
 * 请求体:
 * - gatewayId: Gateway ID
 * - expiresIn: Token 有效期（小时），默认 24 小时
 * - name: 可选，Gateway 名称（当 Gateway 尚不存在时使用）
 * - url: 可选，Gateway URL（当 Gateway 尚不存在时使用）
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { gatewayId, expiresIn = 24, name, url } = body;

    if (!gatewayId) {
      return NextResponse.json(
        { error: 'Gateway ID is required' },
        { status: 400 }
      );
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expiresIn * 60 * 60 * 1000);
    const encryptedToken = encryptToken(rawToken);

    const updated = await prisma.gateway.upsert({
      where: { id: gatewayId },
      update: {
        token: encryptedToken,
        ...(name ? { name } : {}),
        ...(url ? { url } : {}),
        updatedAt: new Date(),
      },
      create: {
        id: gatewayId,
        name: name || gatewayId,
        url: url || null,
        token: encryptedToken,
        status: 'offline',
      },
    });

    return NextResponse.json({
      success: true,
      token: rawToken,
      encrypted: true,
      expiresAt: expiresAt.toISOString(),
      gateway: {
        id: updated.id,
        name: updated.name,
        url: updated.url,
      },
    });
  } catch (error) {
    console.error('Failed to generate token:', error);
    return NextResponse.json(
      { error: 'Failed to generate token' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/gateways/token
 *
 * 验证 Token 是否有效
 *
 * 请求头:
 * - Authorization: Bearer <token>
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Missing or invalid Authorization header' },
        { status: 401 }
      );
    }

    const rawToken = authHeader.substring(7);

    const gateways = await prisma.gateway.findMany({
      where: {
        token: {
          not: null,
        },
      },
    });

    for (const gateway of gateways) {
      try {
        if (!gateway.token) continue;

        const decryptedToken = decryptToken(gateway.token);

        if (decryptedToken === rawToken) {
          return NextResponse.json({
            valid: true,
            gateway: {
              id: gateway.id,
              name: gateway.name,
              url: gateway.url,
              status: gateway.status,
            },
          });
        }
      } catch {
        continue;
      }
    }

    return NextResponse.json(
      { error: 'Invalid token' },
      { status: 401 }
    );
  } catch (error) {
    console.error('Failed to validate token:', error);
    return NextResponse.json(
      { error: 'Failed to validate token' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/gateways/token
 *
 * 撤销指定 Gateway 的 Token
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { gatewayId } = body;

    if (!gatewayId) {
      return NextResponse.json(
        { error: 'Gateway ID is required' },
        { status: 400 }
      );
    }

    const updated = await prisma.gateway.update({
      where: { id: gatewayId },
      data: {
        token: null,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Token revoked',
      gateway: {
        id: updated.id,
        name: updated.name,
      },
    });
  } catch (error) {
    console.error('Failed to revoke token:', error);
    return NextResponse.json(
      { error: 'Failed to revoke token' },
      { status: 500 }
    );
  }
}
