import { applyGraphControlOutput } from './task-graph/conversation-intent';
import { failRoomTurnCard } from './feishu-turn-card';
import { prisma } from '@/lib/prisma';
import {
  clearLiveRoomRunningProcess,
  getLiveRoomRunningProcess,
  interruptLiveRoomRunningProcess,
} from '@/lib/live-room-process-registry';
import {
  detectLiveRoomMentionAll,
  detectMentionedLiveRoomMembers,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import {
  LIVE_ROOM_CONTROL_BLOCK_PATTERN,
  ensureMemberSession,
  executeLiveRoomControlAction,
  inferDirectedVisibleRelayTargets,
  parseLiveRoomControlAction,
} from '@/lib/live-room-delivery-routing';
import {
  executeLiveRoomReplyViaAcpx,
  normalizeLiveRoomExecutionError,
} from '@/lib/live-room-delivery-execution';
import {
  detectLiveRoomHandoffIntent,
  applyPlannedLiveRoomHandoff,
  recordRejectedLiveRoomHandoff,
} from '@/lib/live-room-handoff';
import { resolveRemoteDeliveryStaleAfterMs } from '@/lib/live-room-execution-timeout';

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
const failStaleRemoteDeliveries = async (memberId: string, executionTimeoutMs?: number | null) => {
  // Reclaim threshold follows the room's effective execution timeout plus grace, so a
  // room configured with a longer timeout is not falsely reaped at the old 10m30s mark.
  const remoteStaleAfterMs = resolveRemoteDeliveryStaleAfterMs(executionTimeoutMs);
  const staleBefore = new Date(Date.now() - remoteStaleAfterMs);
  const registryEntry = getLiveRoomRunningProcess(memberId);

  if (registryEntry && Date.now() - registryEntry.startedAt >= remoteStaleAfterMs) {
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

export const processLiveRoomDelivery = async ({
  deliveryId,
  roomId,
  roomMessageId,
  targetMemberId,
  chainDepth,
}: {
  deliveryId: string;
  roomId: string;
  roomMessageId: string;
  targetMemberId: string;
  chainDepth: number;
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
  const relayOrigin = {
    feishuBindingId: typeof sourceMetadata?.feishuBindingId === 'string'
      ? sourceMetadata.feishuBindingId
      : undefined,
    feishuChatId: typeof sourceMetadata?.feishuChatId === 'string'
      ? sourceMetadata.feishuChatId
      : undefined,
  };

  const delivery = await prisma.liveRoomDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery || delivery.deliveryStatus !== 'pending') {
    return;
  }

  const targetMember = room.members.find((member) => member.id === targetMemberId);
  const handoffUnavailableReason = delivery.handoffRootMessageId && targetMember
    ? targetMember.joinStatus !== 'joined'
      ? 'Handoff target was removed from the room'
      : !targetMember.canReply
      ? 'Handoff target was stopped'
      : targetMember.presenceStatus === 'offline'
      ? 'Handoff target is offline'
      : null
    : null;
  if (!targetMember || !targetMember.canReply || handoffUnavailableReason) {
    const fallbackReason = handoffUnavailableReason || 'Live room target cannot reply';
    await prisma.liveRoomDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: 'failed',
        fallbackReason,
        acknowledgedAt: new Date(),
      },
    });
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：handoff 目标不可用：${fallbackReason}。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId,
        extras: {
          ...relayOrigin,
          systemEvent: 'handoff_target_unavailable',
          deliveryId,
        },
      }),
    });
    return null;
  }

  const session = await ensureMemberSession(room.id, targetMember);

  if (targetMember.backend === 'remote_ssh') {
    await failStaleRemoteDeliveries(targetMember.id, room.executionTimeoutMs);

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
    await prisma.liveRoomMemberSession.update({
      where: { id: session.id },
      data: {
        status: 'busy',
        lastHeartbeatAt: new Date(),
        lastError: 'progress:acpx participant running',
      },
    }).catch(() => undefined);

    const acpxResult = await executeLiveRoomReplyViaAcpx({
      room,
      sourceMessage: {
        id: sourceMessage.id,
        content: sourceMessage.content, metadata: sourceMessage.metadata,
        senderMember: sourceMessage.senderMember
          ? {
              id: sourceMessage.senderMember.id,
              displayName: sourceMessage.senderMember.displayName,
              memberType: sourceMessage.senderMember.memberType,
            }
          : null,
      },
      targetMember,
      session: {
        id: session.id,
        threadId: session.threadId,
      },
    });

    if (!acpxResult) {
      await prisma.liveRoomDelivery.update({ where: { id: delivery.id }, data: { deliveryStatus: 'delivered', acknowledgedAt: new Date() } });
      return;
    }
    let output = await applyGraphControlOutput({ output: acpxResult.output, roomId: room.id, sourceContent: sourceMessage.content, sourceMetadata: sourceMessage.metadata || null });
    const threadId = acpxResult.threadId;
    const remoteTiming = acpxResult.remoteTiming;

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

    try {
      const roomControl = parseLiveRoomControlAction(output);
      if (roomControl) {
        await executeLiveRoomControlAction({
          roomId: room.id,
          actorDisplayName: targetMember.displayName,
          action: roomControl.action,
        });
        output = roomControl.remainingOutput;
      }
    } catch (roomControlError) {
      await postLiveRoomMessage({
        roomId: room.id,
        content: `系统提示：${targetMember.displayName} 的 room-control 动作执行失败：${roomControlError instanceof Error ? roomControlError.message : 'unknown error'}`,
        messageType: 'system',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'system',
          extras: {
            ...relayOrigin,
            systemEvent: 'room_control_failed',
            actorDisplayName: targetMember.displayName,
          },
        }),
      });
      output = output.replace(LIVE_ROOM_CONTROL_BLOCK_PATTERN, '').trim();
    }

    if (output) {
      const mentionDetection = detectMentionedLiveRoomMembers({
        content: output,
        members: room.members,
        senderMemberId: targetMember.id,
      });
      const requestedHandoffIntent = delivery.handoffRootMessageId
        ? detectLiveRoomHandoffIntent({
            content: output,
            members: room.members,
            senderMemberId: targetMember.id,
          })
        : { kind: 'none' as const };
      const plannedTargets = delivery.handoffRootMessageId
        ? inferDirectedVisibleRelayTargets({ room, sourceMessage, currentTargetMember: targetMember })
        : [];
      const handoffIntent = applyPlannedLiveRoomHandoff(requestedHandoffIntent, plannedTargets[0]?.id);
      const selectedTargetIndex = handoffIntent.kind === 'target'
        ? plannedTargets.findIndex((member) => member.id === handoffIntent.targetMemberId)
        : -1;
      const handoffRemainingMemberIds = selectedTargetIndex >= 0
        ? plannedTargets.slice(selectedTargetIndex + 1).map((member) => member.id)
        : [];
      const startsWithExplicitMention = /^[\s]*[@$][^\s]+/.test(output);
      const isDirectedVisibleReply =
        startsWithExplicitMention
        && mentionDetection.matchType === 'explicit'
        && mentionDetection.memberIds.length === 1
        && !detectLiveRoomMentionAll(output);
      const directedTargetMemberId = isDirectedVisibleReply ? mentionDetection.memberIds[0] : null;
      const directedTargetMember = directedTargetMemberId
        ? room.members.find((member) => member.id === directedTargetMemberId) || null
        : null;

      const assistantMessage = await postLiveRoomMessage({
        roomId: room.id,
        senderMemberId: targetMember.id,
        content: output,
        messageType: 'assistant',
        visibility: isDirectedVisibleReply ? 'directed_visible' : 'room',
        replyToMessageId: sourceMessage.id,
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'assistant',
          targetMemberId: directedTargetMemberId,
          visibilityMode: isDirectedVisibleReply ? 'directed_visible' : 'room',
          replyToMessageId: sourceMessage.id,
          mentionedMemberIds: mentionDetection.memberIds,
          mentionedAll: detectLiveRoomMentionAll(output),
          expectedResponderMemberIds: detectLiveRoomMentionAll(output)
            ? room.members.filter((member) => member.canReply && member.id !== targetMember.id).map((member) => member.id)
            : [],
          handoffToMemberId: handoffIntent.kind === 'target'
            ? handoffIntent.targetMemberId
            : null,
          extras: {
            ...relayOrigin,
            deliveryId: delivery.id,
            backend: targetMember.backend,
            harnessType: targetMember.harnessType,
            executionRole: targetMember.role,
            ...(targetMember.harnessType === 'antigravity' && targetMember.backend === 'platform_local'
              ? { skipFeishuRelay: true } : {}),
            chainDepth,
            remoteTiming,
            footnotes: acpxResult.footnotes,
            targetLocked: isDirectedVisibleReply,
            targetMemberName: handoffIntent.kind === 'target'
              ? room.members.find((member) => member.id === handoffIntent.targetMemberId)?.displayName || null
              : directedTargetMember?.displayName || null,
            handoffRootMessageId: delivery.handoffRootMessageId,
            handoffRemainingMemberIds,
          },
        }),
      });

      if (handoffIntent.kind === 'invalid') {
        const status = handoffIntent.reason === 'multiple_targets'
          ? 'rejected_multiple_targets'
          : 'rejected_unknown_target';
        await recordRejectedLiveRoomHandoff({
          assistantMessageId: assistantMessage.id,
          status,
        });
        await postLiveRoomMessage({
          roomId: room.id,
          content: handoffIntent.reason === 'multiple_targets'
            ? `系统提示：${targetMember.displayName} 的回复包含多个 $member 目标，本次不接力。`
            : `系统提示：${targetMember.displayName} 请求的 $member 不属于当前房间，本次不接力。`,
          messageType: 'system',
          metadata: resolveLiveRoomMessageMetadata({
            senderKind: 'system',
            extras: {
              ...relayOrigin,
              systemEvent: status,
              assistantMessageId: assistantMessage.id,
            },
          }),
        });
      }

      if (handoffIntent.kind === 'target' && delivery.handoffRootMessageId) {
        return {
          assistantMessageId: assistantMessage.id,
          rootMessageId: delivery.handoffRootMessageId,
          targetMemberId: handoffIntent.targetMemberId,
          roomId: room.id,
          sourceMemberName: targetMember.displayName,
          chainDepth,
          relayOrigin,
        };
      }
    }

    return null;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Live room delivery failed';
    const message = normalizeLiveRoomExecutionError(rawMessage);
    const hasTurnCard = targetMember.backend === 'platform_local'
      ? await failRoomTurnCard(sourceMessage.id, targetMember.id, message).catch(() => false) : false;

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

    if (message !== 'Interrupted by user') {
      const isWallClockTimeout = /timed out after \d+ms/i.test(message);
      await postLiveRoomMessage({
        roomId,
        content:
          message === 'Stopped by user'
            ? `系统提示：${targetMember.displayName} 当前回复已被停止。`
            : isWallClockTimeout
            ? `系统提示：${targetMember.displayName} 本次回复执行超时：${message}`
            : `系统提示：${targetMember.displayName} 本次回复失败：${message}`,
        messageType: 'system',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'system',
          targetMemberId: targetMember.id,
          extras: {
            ...relayOrigin,
            error: message,
            skipFeishuRelay: hasTurnCard,
          },
        }),
      });
    }
    return null;
  } finally {
    if (targetMember.backend === 'remote_ssh') {
      clearLiveRoomRunningProcess(targetMember.id, delivery.id);
    }
  }
};
