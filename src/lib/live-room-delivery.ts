import { prisma } from '@/lib/prisma';
import { createOpenClawResponse, extractOpenClawText, getOpenClawGatewayConfig } from '@/lib/openclaw-client';
import { executeClaudeTask } from '@/lib/real-agents/claude-agent';
import { executeCodexTask, resumeCodexSession } from '@/lib/real-agents/codex-agent';
import {
  detectMentionedLiveRoomMembers,
  getLiveRoomTranscript,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const buildPrompt = ({
  roomTitle,
  topic,
  agentLabel,
  transcript,
  latestRoomMessage,
  routingReason,
}: {
  roomTitle: string;
  topic: string | null;
  agentLabel: string;
  transcript: string;
  latestRoomMessage: string;
  routingReason: string;
}) => [
  `You are participating in a live multi-agent room named "${roomTitle}".`,
  `Your identity in this room: ${agentLabel}.`,
  topic ? `Current room topic: ${topic}` : 'Current room topic: none set yet.',
  `Why you are replying now: ${routingReason}`,
  '',
  'Respond like an active collaborator inside an ongoing chat session.',
  'Prefer concise but useful replies. If you suggest actions, explain what you will do next.',
  'If you want another room member to respond next, mention them explicitly with @name in your reply.',
  '',
  'Recent room transcript:',
  transcript || '(no earlier transcript)',
  '',
  'Latest room message to respond to:',
  latestRoomMessage,
].join('\n');

const describeRoutingReason = ({
  sourceMessageContent,
  sourceMetadata,
  targetMemberName,
  roomCurrentSpeakerMemberId,
  targetMemberId,
}: {
  sourceMessageContent: string;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  targetMemberName: string;
  roomCurrentSpeakerMemberId: string | null;
  targetMemberId: string;
}) => {
  if (sourceMetadata?.deliveryIntent === 'handoff' && sourceMetadata.handoffToMemberId === targetMemberId) {
    return `${targetMemberName} received a handoff and is now the main responder.`;
  }

  if (sourceMetadata?.primaryTargetMemberId === targetMemberId) {
    return `${targetMemberName} was explicitly selected as the primary target of the latest message.`;
  }

  if ((sourceMetadata?.mentionedMemberIds || []).includes(targetMemberId)) {
    return `${targetMemberName} was mentioned in the latest message and should answer next.`;
  }

  if (roomCurrentSpeakerMemberId === targetMemberId) {
    return `${targetMemberName} is currently the room's default speaker.`;
  }

  return `${targetMemberName} was chosen as the fallback responder for the latest message: ${sourceMessageContent}`;
};

const getSessionKey = (roomId: string, memberId: string) => `live-room:${roomId}:member:${memberId}`;

const ensureMemberSession = async (roomId: string, member: {
  id: string;
  backend: string | null;
  harnessType: string | null;
}) => {
  const existing = await prisma.liveRoomMemberSession.findFirst({
    where: {
      roomId,
      memberId: member.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (existing) {
    return existing;
  }

  return prisma.liveRoomMemberSession.create({
    data: {
      roomId,
      memberId: member.id,
      backend: member.backend || 'platform_local',
      sessionKey: getSessionKey(roomId, member.id),
      status: 'online',
      supportsStreaming: member.backend === 'platform_local',
      supportsAppendMessage: true,
      supportsInterrupt: member.harnessType === 'codex',
    },
  });
};

const runLocalHarness = async ({
  harnessType,
  prompt,
  threadId,
}: {
  harnessType: string;
  prompt: string;
  threadId?: string | null;
}) => {
  if (harnessType === 'codex') {
    if (threadId) {
      const resumed = await resumeCodexSession({
        threadId,
        prompt,
        timeout: DEFAULT_TIMEOUT_MS,
        workingDirectory: process.cwd(),
      });

      return {
        output: resumed.output,
        threadId: resumed.threadId || threadId,
      };
    }

    const created = await executeCodexTask({
      id: `live-room-${Date.now()}`,
      name: 'Live Room Reply',
      description: prompt,
    }, {
      timeout: DEFAULT_TIMEOUT_MS,
      workingDirectory: process.cwd(),
    });

    if (!created.success) {
      throw new Error(created.error || 'Codex reply failed');
    }

    return {
      output: created.output || 'Codex completed',
      threadId: created.threadId || null,
    };
  }

  if (harnessType === 'claude') {
    const result = await executeClaudeTask({
      id: `live-room-${Date.now()}`,
      name: 'Live Room Reply',
      description: prompt,
    }, {
      timeout: DEFAULT_TIMEOUT_MS,
      workingDirectory: process.cwd(),
    });

    if (!result.success) {
      throw new Error(result.error || 'Claude reply failed');
    }

    return {
      output: result.output || 'Claude completed',
      threadId: null,
    };
  }

  throw new Error(`Unsupported local harness: ${harnessType}`);
};

export const triggerLiveRoomAgentReply = async ({
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth = 0,
}: {
  roomId: string;
  roomMessageId: string;
  targetMemberId?: string | null;
  chainDepth?: number;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      currentSpeaker: true,
      sourceTask: true,
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  });

  if (!room) {
    return;
  }

  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: roomMessageId },
    include: {
      senderMember: true,
    },
  });

  if (!sourceMessage) {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const resolvedTargetMemberId =
    (sourceMetadata?.deliveryIntent === 'handoff' ? sourceMetadata.handoffToMemberId : null)
    || sourceMetadata?.primaryTargetMemberId
    || sourceMetadata?.mentionedMemberIds?.[0]
    || targetMemberId
    || room.currentSpeakerMemberId
    || null;

  const targetMember =
    room.members.find((member) => member.id === resolvedTargetMemberId)
    || room.members.find((member) => member.id === room.currentSpeakerMemberId)
    || room.members.find((member) => member.canReply)
    || null;

  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const session = await ensureMemberSession(room.id, targetMember);
  const delivery = await prisma.liveRoomDelivery.create({
    data: {
      roomMessageId,
      targetMemberId: targetMember.id,
      sessionId: session.id,
      deliveryStatus: 'pending',
    },
  });

  await prisma.liveRoomMember.update({
    where: { id: targetMember.id },
    data: {
      presenceStatus: 'busy',
    },
  });

  try {
    const transcript = await getLiveRoomTranscript(room.id, 30);
    const prompt = buildPrompt({
      roomTitle: room.title,
      topic: room.currentTopic,
      agentLabel: targetMember.displayName,
      transcript,
      latestRoomMessage: sourceMessage.content,
      routingReason: describeRoutingReason({
        sourceMessageContent: sourceMessage.content,
        sourceMetadata,
        targetMemberName: targetMember.displayName,
        roomCurrentSpeakerMemberId: room.currentSpeakerMemberId,
        targetMemberId: targetMember.id,
      }),
    });

    let output = '';
    let threadId: string | null = session.threadId;

    if (targetMember.backend === 'gateway_openclaw') {
      if (!targetMember.gatewayId) {
        throw new Error('Gateway member missing gatewayId');
      }

      const config = await getOpenClawGatewayConfig(targetMember.gatewayId);
      if (!config) {
        throw new Error(`Gateway "${targetMember.gateway?.name || targetMember.gatewayId}" not configured`);
      }

      const response = await createOpenClawResponse(config, {
        input: prompt,
        agentId: targetMember.runtimeAgentId || targetMember.agentRecord?.runtimeAgentId || 'main',
        sessionKey: session.sessionKey,
      });
      output = extractOpenClawText(response) || '远端 agent 已处理，但未返回可解析文本。';
    } else {
      const result = await runLocalHarness({
        harnessType: targetMember.harnessType || 'codex',
        prompt,
        threadId: session.threadId,
      });
      output = result.output;
      threadId = result.threadId;
    }

    if (threadId !== session.threadId || session.status !== 'online') {
      await prisma.liveRoomMemberSession.update({
        where: { id: session.id },
        data: {
          threadId,
          status: 'online',
          lastDeliveredAt: new Date(),
          lastHeartbeatAt: new Date(),
          lastError: null,
        },
      });
    } else {
      await prisma.liveRoomMemberSession.update({
        where: { id: session.id },
        data: {
          lastDeliveredAt: new Date(),
          lastHeartbeatAt: new Date(),
          lastError: null,
        },
      });
    }

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'delivered',
        acknowledgedAt: new Date(),
      },
    });

    await prisma.liveRoomMember.update({
      where: { id: targetMember.id },
      data: {
        presenceStatus: 'online',
      },
    });

    const replyMessage = await postLiveRoomMessage({
      roomId: room.id,
      senderMemberId: targetMember.id,
      content: output,
      messageType: 'assistant',
      replyToMessageId: sourceMessage.id,
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'assistant',
        replyToMessageId: sourceMessage.id,
        mentionedMemberIds: detectMentionedLiveRoomMembers({
          content: output,
          members: room.members,
          senderMemberId: targetMember.id,
        }),
        extras: {
          deliveryId: delivery.id,
          backend: targetMember.backend,
          harnessType: targetMember.harnessType,
          chainDepth,
        },
      }),
    });

    if (chainDepth < 2) {
      const replyMetadata = parseLiveRoomMessageMetadata(JSON.stringify(replyMessage.metadata || null));
      const nextMentionedMemberId = replyMetadata?.primaryTargetMemberId || replyMetadata?.mentionedMemberIds?.[0] || null;

      if (nextMentionedMemberId) {
        await triggerLiveRoomAgentReply({
          roomId: room.id,
          roomMessageId: replyMessage.id,
          targetMemberId: nextMentionedMemberId,
          chainDepth: chainDepth + 1,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live room delivery failed';

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: message,
      },
    });

    await prisma.liveRoomMemberSession.update({
      where: { id: session.id },
      data: {
        status: 'online',
        lastError: message,
      },
    });

    await prisma.liveRoomMember.update({
      where: { id: targetMember.id },
      data: {
        presenceStatus: 'idle',
      },
    });

    await postLiveRoomMessage({
      roomId,
      content: `系统提示：${targetMember.displayName} 本次回复失败：${message}`,
      messageType: 'system',
      metadata: {
        targetMemberId: targetMember.id,
        error: message,
      },
    });
  }
};
