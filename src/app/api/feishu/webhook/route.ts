import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import {
  getFeishuChallengeResponse,
  handleFeishuCommand,
  hydrateFeishuMessageResources,
  normalizeFeishuPayload,
  parseFeishuCommand,
  parseFeishuMessage,
  validateFeishuRequestSignature,
  validateFeishuVerificationToken,
} from '@/lib/feishu';
import { addTypingReaction, removeTypingReaction, sendFeishuTextMessage } from '@/lib/feishu-api';
import { maybeSendFeishuSessionWatermarkWarning } from '@/lib/feishu-session-continuity';
import { ensureFeishuConversationBinding, tryRelayNonCommandToLiveRoom } from '@/lib/feishu-live-room';
import { listLiveRoomCatalogAgents } from '@/lib/live-room';
import { checkFeishuDirectMessageAccess } from '@/lib/feishu-access-approval';

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
  try {
    const agents = await listLiveRoomCatalogAgents();
    const suggestedAgent =
      agents.find((agent) => agent.backend === 'platform_local' && agent.harnessType === 'codex')
      || agents.find((agent) => agent.backend === 'platform_local')
      || agents[0];

    if (suggestedAgent) {
      return `当前会话还没有绑定到 live room，所以普通消息不会转发给 agent。先发送 \`/ap room --agents=${suggestedAgent.id}\` 创建绑定。默认会优先选择本机 pi-agent，本机 codex 作为托底。也可以先发送 \`/ap agents\` 查看可用 agent ID，或发送 \`/ap help\` 查看可用命令。`;
    }
  } catch (error) {
    console.error('Failed to build Feishu live-room binding hint:', error);
  }

  return '当前会话还没有绑定到 live room，所以普通消息不会转发给 agent。先发送 `/ap agents` 查看可用 agent ID，再用 `/ap room --agents=<agentId>` 创建绑定，或发送 `/ap help` 查看可用命令。';
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
    const message = parsedMessage ? await hydrateFeishuMessageResources(parsedMessage) : null;
    if (!message) {
      return NextResponse.json({ success: true, ignored: true });
    }

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
      let autoBound = false;
      let autoBoundRoomId: string | null = null;
      let relayed = await tryRelayNonCommandToLiveRoom({
        context: {
          chatId: message.chatId,
          chatType: message.chatType,
          senderOpenId: message.senderOpenId,
          messageId: message.messageId,
          mentionNames: message.mentionNames,
        },
        content: message.text,
        typingReactionId: relayTypingReactionId ?? undefined,
      }).catch((err) => {
        console.error('Failed to relay non-command to live room:', err);
        return false;
      });
      if (!relayed && message.chatType === 'group') {
        const autoBinding = await ensureFeishuConversationBinding({
          context: {
            chatId: message.chatId,
            chatType: message.chatType,
            senderOpenId: message.senderOpenId,
            messageId: message.messageId,
            mentionNames: message.mentionNames,
          },
          allowDefaultAgent: true,
        }).catch((err) => {
          console.error('Failed to auto-bind Feishu group to live room:', err);
          return null;
        });

        if (autoBinding) {
          autoBound = autoBinding.created;
          autoBoundRoomId = autoBinding.liveRoomId;
          relayed = await tryRelayNonCommandToLiveRoom({
            context: {
              chatId: message.chatId,
              chatType: message.chatType,
              senderOpenId: message.senderOpenId,
              messageId: message.messageId,
              mentionNames: message.mentionNames,
            },
            content: message.text,
            typingReactionId: relayTypingReactionId ?? undefined,
          }).catch((err) => {
            console.error('Failed to relay non-command after auto-binding live room:', err);
            return false;
          });
        }
      }
      if (!relayed && relayTypingReactionId) {
        await removeTypingReaction(message.messageId, relayTypingReactionId);
      }
      if (relayed && autoBound && autoBoundRoomId) {
        await sendFeishuTextMessage({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          replyId: message.messageId,
          text: `已自动绑定到 Live Room ${autoBoundRoomId}，默认成员已加入（优先使用本机 pi-agent，本机 codex 作为托底）。现在可以直接继续聊，也可以用 /ap add 拉其他 agent。`,
        }).catch((replyError) => {
          console.error('Failed to send Feishu auto-bind confirmation:', replyError);
        });
      }
      if (!relayed && message.chatType === 'p2p') {
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
