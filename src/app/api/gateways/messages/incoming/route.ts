import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateGatewayToken } from '@/lib/gateway-auth';

/**
 * POST /api/gateways/messages/incoming
 * 
 * 接收来自其他 Gateway 的消息
 * 
 * 需要 Token 认证（验证发送者）
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
      fromGatewayId,
      message,
      type = 'direct',
    } = body;

    if (!fromGatewayId || !message) {
      return NextResponse.json(
        { error: 'Missing required fields: fromGatewayId, message' },
        { status: 400 }
      );
    }

    // 验证发送者 Gateway 是否与 Token 匹配
    if (fromGatewayId !== auth.gateway.id) {
      return NextResponse.json(
        { error: 'Gateway ID mismatch' },
        { status: 403 }
      );
    }

    // 创建接收到的消息记录
    const receivedMessage = await prisma.incomingGatewayMessage.create({
      data: {
        fromGatewayId,
        message: typeof message === 'string' ? message : JSON.stringify(message),
        type,
        status: 'received',
        receivedAt: new Date(),
      },
    });

    // TODO: 在这里处理消息
    // 例如：转发到 WebSocket、触发 Agent 响应等

    return NextResponse.json({
      success: true,
      messageId: receivedMessage.id,
      received: true,
    });
  } catch (error) {
    console.error('Failed to process incoming message:', error);
    return NextResponse.json(
      { error: 'Failed to process message' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/gateways/messages/incoming
 * 
 * 获取接收到的消息历史
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

    const where: any = {};

    if (status) {
      where.status = status;
    }

    const messages = await prisma.incomingGatewayMessage.findMany({
      where,
      orderBy: {
        receivedAt: 'desc',
      },
      take: limit,
      include: {
        fromGateway: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const formatted = messages.map((msg) => ({
      ...msg,
      message: typeof msg.message === 'string' ? JSON.parse(msg.message) : msg.message,
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch incoming messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}
