import { prisma } from '@/lib/prisma';
import { decryptToken } from '@/lib/encryption';

export interface GatewayMessage {
  id: string;
  fromGatewayId: string;
  toGatewayId: string;
  type: 'direct' | 'broadcast' | 'request';
  payload: Record<string, unknown>;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  createdAt: Date;
  deliveredAt?: Date | null;
  error?: string | null;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function getGatewayRawToken(gatewayId: string): Promise<string | null> {
  const gateway = await prisma.gateway.findUnique({
    where: { id: gatewayId },
    select: { token: true },
  });

  if (!gateway?.token) {
    return null;
  }

  return decryptToken(gateway.token);
}

/**
 * 将消息路由到目标 Gateway
 *
 * 如果目标 Gateway 在线且有 URL，尝试直接发送
 * 否则将消息存入队列等待重试
 */
export async function routeMessageToGateway(
  fromGatewayId: string,
  toGatewayId: string,
  payload: Record<string, unknown>,
  type: 'direct' | 'broadcast' | 'request' = 'direct'
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const message = await prisma.gatewayMessage.create({
      data: {
        fromGatewayId,
        toGatewayId,
        type,
        payload: JSON.stringify(payload),
        status: 'pending',
      },
    });

    const [sourceToken, targetGateway] = await Promise.all([
      getGatewayRawToken(fromGatewayId),
      prisma.gateway.findUnique({
        where: { id: toGatewayId },
        select: {
          id: true,
          url: true,
          status: true,
        },
      }),
    ]);

    if (!sourceToken) {
      await prisma.gatewayMessage.update({
        where: { id: message.id },
        data: {
          status: 'failed',
          error: 'Source gateway token not configured',
        },
      });
      return {
        success: false,
        messageId: message.id,
        error: 'Source gateway token not configured',
      };
    }

    if (!targetGateway) {
      await prisma.gatewayMessage.update({
        where: { id: message.id },
        data: {
          status: 'failed',
          error: 'Target gateway not found',
        },
      });
      return {
        success: false,
        messageId: message.id,
        error: 'Target gateway not found',
      };
    }

    if (!targetGateway.url) {
      await prisma.gatewayMessage.update({
        where: { id: message.id },
        data: {
          status: 'pending',
          error: 'Target gateway URL not configured',
        },
      });
      return {
        success: false,
        messageId: message.id,
        error: 'Target gateway URL not configured',
      };
    }

    try {
      const messageUrl = joinUrl(targetGateway.url, '/api/gateways/messages/incoming');

      const response = await fetch(messageUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sourceToken}`,
        },
        body: JSON.stringify({
          fromGatewayId,
          message: payload,
          type,
        }),
      });

      if (response.ok) {
        await prisma.gatewayMessage.update({
          where: { id: message.id },
          data: {
            status: 'sent',
            deliveredAt: new Date(),
            error: null,
          },
        });
        return {
          success: true,
          messageId: message.id,
        };
      }

      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
    } catch (error) {
      await prisma.gatewayMessage.update({
        where: { id: message.id },
        data: {
          status: 'pending',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      return {
        success: false,
        messageId: message.id,
        error: error instanceof Error ? error.message : 'Failed to send',
      };
    }
  } catch (error) {
    console.error('Failed to route message:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 广播消息到所有在线 Gateway
 */
export async function broadcastToGateways(
  fromGatewayId: string,
  payload: Record<string, unknown>
): Promise<{ success: number; failed: number; total: number }> {
  const gateways = await prisma.gateway.findMany({
    where: {
      status: 'online',
      id: { not: fromGatewayId },
    },
  });

  let success = 0;
  let failed = 0;

  for (const gateway of gateways) {
    const result = await routeMessageToGateway(
      fromGatewayId,
      gateway.id,
      payload,
      'broadcast'
    );
    if (result.success) {
      success++;
    } else {
      failed++;
    }
  }

  return {
    success,
    failed,
    total: gateways.length,
  };
}

/**
 * 获取待重试的消息队列
 */
export async function getPendingMessages(limit: number = 10) {
  return prisma.gatewayMessage.findMany({
    where: {
      status: 'pending',
    },
    orderBy: {
      createdAt: 'asc',
    },
    take: limit,
    include: {
      fromGateway: true,
      toGateway: true,
    },
  });
}

/**
 * 重试发送失败的消息
 */
export async function retryPendingMessages() {
  const pendingMessages = await getPendingMessages();
  const results = {
    success: 0,
    failed: 0,
    total: pendingMessages.length,
  };

  for (const message of pendingMessages) {
    const result = await routeMessageToGateway(
      message.fromGatewayId,
      message.toGatewayId,
      JSON.parse(message.payload as string),
      message.type as 'direct' | 'broadcast' | 'request'
    );

    if (result.success) {
      results.success++;
    } else {
      results.failed++;
    }
  }

  return results;
}
