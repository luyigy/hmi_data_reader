import type { ChildProcess } from 'child_process';
import { prisma } from '@/lib/prisma';
import { createOpenClawResponse, extractOpenClawText, getOpenClawGatewayConfig } from '@/lib/openclaw-client';
import { executeClaudeTask } from '@/lib/real-agents/claude-agent';
import { executeCodexTask, resumeCodexSession } from '@/lib/real-agents/codex-agent';
import {
  clearLiveRoomRunningProcess,
  enqueueLiveRoomMemberExecution,
  getLiveRoomRunningProcess,
  interruptLiveRoomRunningProcess,
  registerLiveRoomRunningProcess,
} from '@/lib/live-room-process-registry';
import { getRemoteHarnessHostById } from '@/lib/remote-harness/hosts';
import { executeRemoteSshTask } from '@/lib/remote-harness/ssh-executor';
import {
  buildLiveRoomRosterText,
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  extractRemoteHostIdFromRoleLabel,
  getLiveRoomTranscript,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ALL_REPLY_STAGGER_MS = 750;
const REMOTE_STALE_GRACE_MS = 30 * 1000;
const REMOTE_STALE_AFTER_MS = DEFAULT_TIMEOUT_MS + REMOTE_STALE_GRACE_MS;

type DeliveryRoomMember = {
  id: string;
  canReply: boolean;
  displayName: string;
  backend: string | null;
  harnessType: string | null;
  runtimeAgentId: string | null;
  gatewayId: string | null;
  roleLabel?: string | null;
  gateway?: { name: string } | null;
  agentRecord?: { runtimeAgentId: string | null } | null;
};

type DeliveryRoom = {
  id: string;
  title: string;
  currentTopic: string | null;
  currentSpeakerMemberId: string | null;
  members: DeliveryRoomMember[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildPrompt = ({
  roomTitle,
  topic,
  agentLabel,
  roster,
  transcript,
  latestRoomMessage,
  routingReason,
}: {
  roomTitle: string;
  topic: string | null;
  agentLabel: string;
  roster: string;
  transcript: string;
  latestRoomMessage: string;
  routingReason: string;
}) => [
  `You are participating in a live multi-agent room named "${roomTitle}".`,
  `Your identity in this room: ${agentLabel}.`,
  topic ? `Current room topic: ${topic}` : 'Current room topic: none set yet.',
  'Current room members:',
  roster || '(no members recorded)',
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

const getReplyEligibleMembers = ({
  room,
  sourceSenderMemberId,
}: {
  room: DeliveryRoom | null;
  sourceSenderMemberId?: string | null;
}) => (room?.members || []).filter((member: DeliveryRoomMember) => member.canReply && member.id !== sourceSenderMemberId);

const getPrimaryReplyTarget = ({
  room,
  sourceMessageSenderMemberId,
  sourceMetadata,
  requestedTargetMemberId,
  preferRequestedTarget = false,
}: {
  room: DeliveryRoom;
  sourceMessageSenderMemberId?: string | null;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  requestedTargetMemberId?: string | null;
  preferRequestedTarget?: boolean;
}) => {
  const eligibleMembers = getReplyEligibleMembers({
    room,
    sourceSenderMemberId: sourceMessageSenderMemberId,
  });

  const baseCandidates = [
    sourceMetadata?.deliveryIntent === 'handoff' ? sourceMetadata.handoffToMemberId : null,
    sourceMetadata?.primaryTargetMemberId || null,
    sourceMetadata?.mentionedMemberIds?.[0] || null,
    room.currentSpeakerMemberId || null,
  ].filter(Boolean) as string[];

  const candidates = preferRequestedTarget
    ? [requestedTargetMemberId || null, ...baseCandidates]
    : [...baseCandidates, requestedTargetMemberId || null];

  for (const candidate of candidates) {
    const found = eligibleMembers.find((member: DeliveryRoomMember) => member.id === candidate);
    if (found) {
      return found;
    }
  }

  return eligibleMembers[0] || null;
};

const getTargetMemberIdsForMessage = ({
  room,
  sourceMessageSenderMemberId,
  sourceMetadata,
  requestedTargetMemberId,
}: {
  room: DeliveryRoom;
  sourceMessageSenderMemberId?: string | null;
  sourceMetadata: ReturnType<typeof parseLiveRoomMessageMetadata>;
  requestedTargetMemberId?: string | null;
}) => {
  const eligibleMembers = getReplyEligibleMembers({
    room,
    sourceSenderMemberId: sourceMessageSenderMemberId,
  });

  if (sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll) {
    const expectedIds = (sourceMetadata.expectedResponderMemberIds || []).filter(Boolean) as string[];
    const targets = (expectedIds.length > 0 ? expectedIds : eligibleMembers.map((member: DeliveryRoomMember) => member.id))
      .filter((memberId: string, index: number, list: string[]) => list.indexOf(memberId) === index)
      .filter((memberId: string) => eligibleMembers.some((member: DeliveryRoomMember) => member.id === memberId));

    return targets;
  }

  const primaryTarget = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
  });

  return primaryTarget ? [primaryTarget.id] : [];
};

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
      supportsInterrupt: member.harnessType === 'codex' || member.backend === 'remote_ssh',
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

const runRemoteHarness = async ({
  gatewayId,
  harnessType,
  prompt,
  onSpawn,
  onProgress,
}: {
  gatewayId: string;
  harnessType: string;
  prompt: string;
  onSpawn?: (child: ChildProcess) => void;
  onProgress?: (event: {
    phase: 'ssh_spawned' | 'remote_command_started' | 'first_stdout' | 'first_stderr' | 'streaming_output' | 'completed';
    at: number;
  }) => void;
}) => {
  const remoteHost = await getRemoteHarnessHostById(gatewayId);

  if (!remoteHost) {
    throw new Error(`Remote SSH host not found: ${gatewayId}`);
  }

  if (!remoteHost.supportedHarnesses.includes(harnessType.toLowerCase())) {
    throw new Error(
      `Remote SSH host "${remoteHost.label}" does not declare harness "${harnessType}"`
    );
  }

  const result = await executeRemoteSshTask(
    {
      id: `live-room-remote-${Date.now()}`,
      name: 'Live Room Reply',
      description: prompt,
    },
    {
      timeout: DEFAULT_TIMEOUT_MS,
      harnessType,
      host: remoteHost,
      onSpawn,
      onProgress,
    }
  );

  return {
    output: result.output,
    threadId: null,
    timing: result.timing,
  };
};

const markRemoteDeliverySuperseded = async (deliveryId: string, reason: string) => {
  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      targetMember: {
        select: {
          id: true,
        },
      },
      session: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!delivery || (delivery.deliveryStatus !== 'pending' && delivery.deliveryStatus !== 'running')) {
    return false;
  }

  await prisma.liveRoomDelivery.update({
    where: { id: deliveryId },
    data: {
      deliveryStatus: 'superseded',
      fallbackReason: reason,
      acknowledgedAt: new Date(),
    },
  });

  if (delivery.sessionId) {
    await prisma.liveRoomMemberSession.update({
      where: { id: delivery.sessionId },
      data: {
        status: 'online',
        lastError: reason,
      },
    }).catch(() => undefined);
  }

  await prisma.liveRoomMember.update({
    where: { id: delivery.targetMemberId },
    data: {
      presenceStatus: 'online',
    },
  }).catch(() => undefined);

  return true;
};

const failStaleRemoteDeliveries = async (memberId: string) => {
  const staleBefore = new Date(Date.now() - REMOTE_STALE_AFTER_MS);
  const registryEntry = getLiveRoomRunningProcess(memberId);

  if (registryEntry && Date.now() - registryEntry.startedAt >= REMOTE_STALE_AFTER_MS) {
    interruptLiveRoomRunningProcess(memberId, 'SIGTERM');
  }

  const staleDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: memberId,
      deliveryStatus: {
        in: ['pending', 'running'],
      },
      attemptedAt: {
        lt: staleBefore,
      },
    },
    include: {
      session: {
        select: {
          id: true,
        },
      },
    },
  });

  for (const delivery of staleDeliveries) {
    if (registryEntry?.deliveryId === delivery.id) {
      continue;
    }

    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: 'Remote SSH live room delivery became stale before completion',
        acknowledgedAt: new Date(),
      },
    });

    if (delivery.sessionId) {
      await prisma.liveRoomMemberSession.update({
        where: { id: delivery.sessionId },
        data: {
          status: 'online',
          lastError: 'Remote SSH live room delivery became stale before completion',
        },
      }).catch(() => undefined);
    }
  }

  if (staleDeliveries.length > 0) {
    await prisma.liveRoomMember.update({
      where: { id: memberId },
      data: {
        presenceStatus: 'online',
      },
    }).catch(() => undefined);
  }
};

const processLiveRoomDelivery = async ({
  deliveryId,
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth,
  allowChainedMentions,
}: {
  deliveryId: string;
  roomId: string;
  roomMessageId: string;
  targetMemberId: string;
  chainDepth: number;
  allowChainedMentions: boolean;
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

  const targetMember = room.members.find((member) => member.id === targetMemberId);
  if (!targetMember || !targetMember.canReply) {
    return;
  }

  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery || delivery.deliveryStatus !== 'pending') {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const session = await ensureMemberSession(room.id, targetMember);

  if (targetMember.backend === 'remote_ssh') {
    await failStaleRemoteDeliveries(targetMember.id);

    const newerPendingDelivery = await prisma.liveRoomDelivery.findFirst({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        createdAt: {
          gt: delivery.createdAt,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
      },
    });

    if (newerPendingDelivery) {
      await markRemoteDeliverySuperseded(
        delivery.id,
        `Superseded by newer live room delivery ${newerPendingDelivery.id}`
      );
      return;
    }
  }

  await prisma.liveRoomDelivery.update({
    where: { id: delivery.id },
    data: {
      sessionId: session.id,
      deliveryStatus: 'running',
      attemptedAt: new Date(),
      fallbackReason: null,
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
    const roster = buildLiveRoomRosterText(room.members);
    const prompt = buildPrompt({
      roomTitle: room.title,
      topic: room.currentTopic,
      agentLabel: targetMember.displayName,
      roster,
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
    let remoteTiming: {
      sshStartMs: number;
      remoteCommandStartMs?: number;
      firstStdoutMs?: number;
      firstStderrMs?: number;
      totalMs: number;
    } | null = null;

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
    } else if (targetMember.backend === 'remote_ssh') {
      const remoteHostId = extractRemoteHostIdFromRoleLabel(targetMember.roleLabel) || targetMember.gatewayId;

      if (!remoteHostId) {
        throw new Error('Remote SSH member missing host id');
      }

      const result = await runRemoteHarness({
        gatewayId: remoteHostId,
        harnessType: targetMember.harnessType || 'claude',
        prompt,
        onSpawn: (child) => {
          registerLiveRoomRunningProcess({
            deliveryId: delivery.id,
            roomId: room.id,
            memberId: targetMember.id,
            sessionId: session.id,
            child,
            executionBackend: 'remote_ssh',
            harnessType: targetMember.harnessType || 'claude',
            startedAt: Date.now(),
          });
        },
        onProgress: async (event) => {
          const progressLabelByPhase: Record<typeof event.phase, string> = {
            ssh_spawned: 'SSH connecting',
            remote_command_started: 'remote command started',
            first_stdout: 'remote stdout received',
            first_stderr: 'remote stderr received',
            streaming_output: 'remote output streaming',
            completed: 'remote command completed',
          };

          await prisma.liveRoomMemberSession.update({
            where: { id: session.id },
            data: {
              status: 'busy',
              lastHeartbeatAt: new Date(event.at),
              lastError: `progress:${progressLabelByPhase[event.phase]}`,
            },
          }).catch(() => undefined);
        },
      });
      output = result.output;
      threadId = result.threadId;
      remoteTiming = result.timing;
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
        mentionedAll: detectLiveRoomMentionAll(output),
        expectedResponderMemberIds: detectLiveRoomMentionAll(output)
          ? room.members.filter((member) => member.canReply && member.id !== targetMember.id).map((member) => member.id)
          : [],
        extras: {
          deliveryId: delivery.id,
          backend: targetMember.backend,
          harnessType: targetMember.harnessType,
          chainDepth,
          remoteTiming,
        },
      }),
    });

    if (allowChainedMentions && chainDepth < 2) {
      const replyMetadata = parseLiveRoomMessageMetadata(JSON.stringify(replyMessage.metadata || null));
      const nextTargetMemberIds = getTargetMemberIdsForMessage({
        room,
        sourceMessageSenderMemberId: targetMember.id,
        sourceMetadata: replyMetadata,
        requestedTargetMemberId: null,
      });

      for (const nextTargetMemberId of nextTargetMemberIds) {
        await triggerLiveRoomAgentReply({
          roomId: room.id,
          roomMessageId: replyMessage.id,
          targetMemberId: nextTargetMemberId,
          chainDepth: chainDepth + 1,
          allowChainedMentions: !(replyMetadata?.deliveryIntent === 'mention_all' || replyMetadata?.mentionedAll),
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
        acknowledgedAt: new Date(),
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
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: targetMember.id,
        extras: {
          error: message,
        },
      }),
    });
  } finally {
    if (targetMember.backend === 'remote_ssh') {
      clearLiveRoomRunningProcess(targetMember.id, delivery.id);
    }
  }
};

export const interruptLiveRoomMemberReplies = async ({
  roomId,
  memberId,
}: {
  roomId: string;
  memberId: string;
}) => {
  const member = await prisma.liveRoomMember.findFirst({
    where: {
      id: memberId,
      roomId,
    },
    select: {
      id: true,
      displayName: true,
      backend: true,
      canReply: true,
    },
  });

  if (!member) {
    throw new Error('Live room member not found');
  }

  if (!member.canReply) {
    throw new Error('Selected member cannot reply');
  }

  if (member.backend !== 'remote_ssh') {
    throw new Error('Only remote SSH live room replies can be interrupted in Phase 1');
  }

  const runningDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: member.id,
      roomMessage: {
        roomId,
      },
      deliveryStatus: 'running',
    },
    orderBy: {
      attemptedAt: 'desc',
    },
  });

  const queuedDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      targetMemberId: member.id,
      roomMessage: {
        roomId,
      },
      deliveryStatus: 'pending',
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  const runningRegistry = getLiveRoomRunningProcess(member.id);
  if (runningRegistry) {
    interruptLiveRoomRunningProcess(member.id, 'SIGTERM');
  }

  const interruptedAt = new Date();

  if (runningDeliveries.length > 0) {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        id: {
          in: runningDeliveries.map((delivery) => delivery.id),
        },
      },
      data: {
        deliveryStatus: 'failed',
        fallbackReason: 'Interrupted by user',
        acknowledgedAt: interruptedAt,
      },
    });
  }

  if (queuedDeliveries.length > 0) {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        id: {
          in: queuedDeliveries.map((delivery) => delivery.id),
        },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: 'Cancelled by user before execution',
        acknowledgedAt: interruptedAt,
      },
    });
  }

  const latestSession = await prisma.liveRoomMemberSession.findFirst({
    where: {
      roomId,
      memberId: member.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (latestSession) {
    await prisma.liveRoomMemberSession.update({
      where: { id: latestSession.id },
      data: {
        status: 'online',
        lastError: runningDeliveries.length > 0 ? 'Interrupted by user' : 'Cancelled by user before execution',
      },
    });
  }

  await prisma.liveRoomMember.update({
    where: { id: member.id },
    data: {
      presenceStatus: 'online',
    },
  });

  await postLiveRoomMessage({
    roomId,
    content: `系统提示：已中断 ${member.displayName} 的远端回复${queuedDeliveries.length > 0 ? `，并清理 ${queuedDeliveries.length} 条排队消息` : ''}。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      targetMemberId: member.id,
      extras: {
        systemEvent: 'remote_reply_interrupted',
        interruptedDeliveryIds: runningDeliveries.map((delivery) => delivery.id),
        supersededDeliveryIds: queuedDeliveries.map((delivery) => delivery.id),
      },
    }),
  });

  return {
    interruptedRunningCount: runningDeliveries.length,
    cancelledQueuedCount: queuedDeliveries.length,
  };
};

export const triggerLiveRoomAgentReply = async ({
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth = 0,
  allowChainedMentions = true,
  forceTargetMember = false,
}: {
  roomId: string;
  roomMessageId: string;
  targetMemberId?: string | null;
  chainDepth?: number;
  allowChainedMentions?: boolean;
  forceTargetMember?: boolean;
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
  const targetMember = getPrimaryReplyTarget({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId: targetMemberId,
    preferRequestedTarget: forceTargetMember,
  });

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

  if (targetMember.backend === 'remote_ssh') {
    await prisma.liveRoomDelivery.updateMany({
      where: {
        targetMemberId: targetMember.id,
        deliveryStatus: 'pending',
        id: {
          not: delivery.id,
        },
      },
      data: {
        deliveryStatus: 'superseded',
        fallbackReason: `Superseded by newer live room delivery ${delivery.id}`,
        acknowledgedAt: new Date(),
      },
    });

    await enqueueLiveRoomMemberExecution(targetMember.id, async () => {
      await processLiveRoomDelivery({
        deliveryId: delivery.id,
        roomId: room.id,
        roomMessageId,
        targetMemberId: targetMember.id,
        chainDepth,
        allowChainedMentions,
      });
    });
    return;
  }

  await processLiveRoomDelivery({
    deliveryId: delivery.id,
    roomId: room.id,
    roomMessageId,
    targetMemberId: targetMember.id,
    chainDepth,
    allowChainedMentions,
  });
};

export const triggerLiveRoomMessageReplies = async ({
  roomId,
  roomMessageId,
  requestedTargetMemberId,
}: {
  roomId: string;
  roomMessageId: string;
  requestedTargetMemberId?: string | null;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
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
  });

  if (!sourceMessage) {
    return;
  }

  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const targetMemberIds = getTargetMemberIdsForMessage({
    room,
    sourceMessageSenderMemberId: sourceMessage.senderMemberId,
    sourceMetadata,
    requestedTargetMemberId,
  });

  if (targetMemberIds.length === 0) {
    return;
  }

  const isMentionAll = sourceMetadata?.deliveryIntent === 'mention_all' || sourceMetadata?.mentionedAll;
  if (isMentionAll) {
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：@all 已发送，当前共有 ${targetMemberIds.length} 个可回复成员会按顺序回应。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        mentionedAll: true,
        expectedResponderMemberIds: targetMemberIds,
        requiredResponseMode: 'all',
        extras: {
          systemEvent: 'mention_all_dispatch_started',
        },
      }),
    });
  }

  const allowChainedMentions = !isMentionAll;
  for (let index = 0; index < targetMemberIds.length; index += 1) {
    const targetMemberId = targetMemberIds[index];
    if (index > 0 && isMentionAll) {
      await sleep(ALL_REPLY_STAGGER_MS);
    }

    await triggerLiveRoomAgentReply({
      roomId,
      roomMessageId,
      targetMemberId,
      chainDepth: 0,
      allowChainedMentions,
      forceTargetMember: isMentionAll,
    });
  }
};
