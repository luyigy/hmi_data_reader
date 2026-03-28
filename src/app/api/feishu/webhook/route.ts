import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import {
  getFeishuChallengeResponse,
  handleFeishuCommand,
  normalizeFeishuPayload,
  parseFeishuCommand,
  parseFeishuMessage,
  sendFeishuTextMessage,
  validateFeishuRequestSignature,
  validateFeishuVerificationToken,
} from '@/lib/feishu';

export const dynamic = 'force-dynamic';

function resolveBaseUrl(request: NextRequest): string {
  const appBaseUrl = process.env.AGENT_PLATFORM_BASE_URL?.trim();
  if (appBaseUrl) {
    return appBaseUrl;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    noStore();

    const rawPayload = await request.json();

    if (!validateFeishuRequestSignature({ payload: rawPayload, headers: request.headers })) {
      return NextResponse.json({ error: 'Invalid Feishu request signature' }, { status: 401 });
    }

    const payload = normalizeFeishuPayload(rawPayload);

    if (!validateFeishuVerificationToken(payload)) {
      return NextResponse.json({ error: 'Invalid Feishu verification token' }, { status: 401 });
    }

    const challenge = getFeishuChallengeResponse(payload);
    if (challenge) {
      return NextResponse.json(challenge);
    }

    const message = parseFeishuMessage(payload);
    if (!message) {
      return NextResponse.json({ success: true, ignored: true });
    }

    const selfOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim();
    if (selfOpenId && message.senderOpenId === selfOpenId) {
      return NextResponse.json({ success: true, ignored: true, reason: 'self_message' });
    }

    const command = parseFeishuCommand(message);
    if (!command) {
      return NextResponse.json({ success: true, ignored: true, reason: 'not_a_command' });
    }

    const responseText = await handleFeishuCommand({
      command,
      baseUrl: resolveBaseUrl(request),
      context: {
        chatId: message.chatId,
        chatType: message.chatType,
        senderOpenId: message.senderOpenId,
        messageId: message.messageId,
      },
    });

    await sendFeishuTextMessage({
      receiveId: message.chatId,
      receiveIdType: 'chat_id',
      replyId: message.messageId,
      text: responseText,
    });

    return NextResponse.json({ success: true, handled: true });
  } catch (error) {
    console.error('Failed to handle Feishu webhook:', error);
    try {
      const rawPayload = await request.json().catch(() => null);
      const payload =
        rawPayload && typeof rawPayload === 'object' ? normalizeFeishuPayload(rawPayload as any) : null;
      const message = payload ? parseFeishuMessage(payload as any) : null;
      if (message) {
        await sendFeishuTextMessage({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          replyId: message.messageId,
          text: `命令执行失败：${error instanceof Error ? error.message : 'Failed to handle Feishu webhook'}`,
        });
      }
    } catch (replyError) {
      console.error('Failed to send Feishu webhook error reply:', replyError);
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to handle Feishu webhook',
      },
      { status: 500 }
    );
  }
}
