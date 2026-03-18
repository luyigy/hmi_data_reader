import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateGatewayToken } from '@/lib/gateway-auth';
import { broadcastToGateways, routeMessageToGateway } from '@/lib/gateway-router';

/**
 * POST /api/gateways/messages/send
 * 
 * 发送消息到目标 Gateway
 * 
 * 需要 Token 认证
 */
export async function POST(request: NextRequest) {
  try {
    // 验证发送者 Token
    const auth = await validateGatewayToken(request);
    
    if (!auth.authenticated || !auth.gateway) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const {
      toGatewayId,
      message,
      type = 'direct',
    } = body;

    if (!toGatewayId || !message) {
      return NextResponse.json(
        { error: 'Missing required fields: toGatewayId, message' },
        { status: 400 }
      );
    }

    // 广播消息
    if (type === 'broadcast') {
      const result = await broadcastToGateways(
        auth.gateway.id,
        message
      );
      return NextResponse.json({
        success: true,
        broadcast: result,
      });
    }

    // 单播消息
    const result = await routeMessageToGateway(
      auth.gateway.id,
      toGatewayId,
      message,
      type
    );

    if (result.success) {
      return NextResponse.json({
        success: true,
        messageId: result.messageId,
      });
    } else {
      return NextResponse.json({
        success: false,
        messageId: result.messageId,
        error: result.error,
      }, { status: 500 });
    }
  } catch (error) {
    console.error('Failed to send gateway message:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/gateways/messages
 * 
 * 获取消息历史
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await validateGatewayToken(request);
    
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50');

    const where: any = {
      OR: [
        { fromGatewayId: auth.gateway?.id },
        { toGatewayId: auth.gateway?.id },
      ],
    };

    if (status) {
      where.status = status;
    }

    const messages = await prisma.gatewayMessage.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
      include: {
        fromGateway: {
          select: {
            id: true,
            name: true,
          },
        },
        toGateway: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const formatted = messages.map((msg) => ({
      ...msg,
      payload: typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload,
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}
