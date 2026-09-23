import { buildFeishuTopicIdentity } from '@/lib/feishu-topic-reply';
import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import {
  handleFeishuCommand,
  hydrateFeishuMessageResources,
} from '@/lib/feishu';
import { parseFeishuCommand } from '@/lib/feishu-command-parser';
import {
  getFeishuChallengeResponse,
  normalizeFeishuPayload,
  parseFeishuMessage,
  validateFeishuRequestSignature,
  validateFeishuVerificationToken,
} from '@/lib/feishu-webhook';
import { addTypingReaction, removeTypingReaction, sendFeishuTextMessage } from '@/lib/feishu-api';
import { maybeSendFeishuSessionWatermarkWarning } from '@/lib/feishu-session-continuity';
import { tryRelayNonCommandToLiveRoom, UNBOUND_FEISHU_LIVE_ROOM_HINT } from '@/lib/feishu-live-room';
import { checkFeishuDirectMessageAccess } from '@/lib/feishu-access-approval';
import { shouldTriggerFeishuMessage } from '@/lib/feishu-message-trigger';

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

async function buildUnboundLiveRoomHint(): Promise<string> {
  return UNBOUND_FEISHU_LIVE_ROOM_HINT;
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

    const parsedMessage = parseFeishuMessage(payload);
    if (!parsedMessage) {
      return NextResponse.json({ success: true, ignored: true });
    }
    if (!shouldTriggerFeishuMessage(parsedMessage)) {
      return NextResponse.json({ success: true, ignored: true, reason: 'not_addressed_to_bot' });
    }
    const message = await hydrateFeishuMessageResources(parsedMessage);

    const selfOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim();
    if (selfOpenId && message.senderOpenId === selfOpenId) {
      return NextResponse.json({ success: true, ignored: true, reason: 'self_message' });
    }
    if (!await checkFeishuDirectMessageAccess(message)) {
      return NextResponse.json({ success: true, ignored: true, reason: 'access_pending' });
    }

    const command = parseFeishuCommand(message);
    if (!command) {
      // Not a /ap command — check if the chat is bound to a live room and relay
      const relayTypingReactionId = await addTypingReaction(message.messageId);
      const relayed = await tryRelayNonCommandToLiveRoom({
        context: {
          chatId: message.chatId,
          chatType: message.chatType,
          senderOpenId: message.senderOpenId,
          messageId: message.messageId,
          mentionNames: message.mentionNames,
          ...buildFeishuTopicIdentity(message),
        },
        content: message.text,
        typingReactionId: relayTypingReactionId ?? undefined,
      }).catch((err) => {
        console.error('Failed to relay non-command to live room:', err);
        return false;
      });
      if (!relayed && relayTypingReactionId) {
        await removeTypingReaction(message.messageId, relayTypingReactionId);
      }
      if (!relayed && (message.chatType === 'p2p' || message.chatType === 'group')) {
        await sendFeishuTextMessage({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          replyId: message.messageId,
          text: await buildUnboundLiveRoomHint(),
        });
      }
      if (relayed) {
        await maybeSendFeishuSessionWatermarkWarning({
          context: {
            chatId: message.chatId,
            chatType: message.chatType,
            senderOpenId: message.senderOpenId,
            messageId: message.messageId,
            mentionNames: message.mentionNames,
            ...buildFeishuTopicIdentity(message),
          },
          replyId: message.messageId,
        }).catch((warningError) => {
          console.error('Failed to send session watermark warning:', warningError);
        });
      }
      return NextResponse.json({ success: true, ignored: !relayed, reason: relayed ? 'relayed_to_live_room' : 'not_a_command' });
    }

    const typingReactionId = await addTypingReaction(message.messageId);
    let responseText = '';
    try {
      responseText = await handleFeishuCommand({
        command,
        baseUrl: resolveBaseUrl(request),
        context: {
          chatId: message.chatId,
          chatType: message.chatType,
          senderOpenId: message.senderOpenId,
          messageId: message.messageId,
          mentionNames: message.mentionNames,
          ...buildFeishuTopicIdentity(message),
        },
      });
    } finally {
      if (typingReactionId) {
        await removeTypingReaction(message.messageId, typingReactionId);
      }
    }

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
        rawPayload && typeof rawPayload === 'object'
          ? normalizeFeishuPayload(rawPayload as Parameters<typeof normalizeFeishuPayload>[0])
          : null;
      const message = payload ? parseFeishuMessage(payload) : null;
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
