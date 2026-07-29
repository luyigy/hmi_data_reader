import { prisma } from "@/lib/prisma";
import type { LiveRoomPendingReplyPayload } from "@/lib/live-room-types";

export const listLiveRoomPendingReplies = async (roomId: string): Promise<LiveRoomPendingReplyPayload[]> => {
  const pendingDeliveries = await prisma.liveRoomDelivery.findMany({
    where: {
      deliveryStatus: {
        in: ['pending', 'running'],
      },
      roomMessage: {
        roomId,
      },
    },
    include: {
      targetMember: {
        select: {
          id: true,
          displayName: true,
          backend: true,
          harnessType: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });
  const latestSessions = await prisma.liveRoomMemberSession.findMany({
    where: {
      roomId,
      memberId: {
        in: pendingDeliveries.map((delivery) => delivery.targetMember.id),
      },
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  const now = Date.now();
  const grouped = new Map<string, LiveRoomPendingReplyPayload>();
  const latestSessionByMemberId = new Map<string, typeof latestSessions[number]>();

  for (const session of latestSessions) {
    if (!latestSessionByMemberId.has(session.memberId)) {
      latestSessionByMemberId.set(session.memberId, session);
    }
  }

  for (const delivery of pendingDeliveries) {
    const existing = grouped.get(delivery.targetMember.id);
    const createdAtIso = delivery.createdAt.toISOString();
    const createdAtMs = delivery.createdAt.getTime();

    if (!existing) {
      grouped.set(delivery.targetMember.id, {
        memberId: delivery.targetMember.id,
        displayName: delivery.targetMember.displayName,
        pendingCount: 1,
        queuedCount: delivery.deliveryStatus === 'pending' ? 1 : 0,
        runningCount: delivery.deliveryStatus === 'running' ? 1 : 0,
        oldestPendingAt: createdAtIso,
        newestPendingAt: createdAtIso,
        newestPendingAgeSeconds: Math.max(0, Math.floor((now - createdAtMs) / 1000)),
        lastProgressAt: null,
        lastProgressAgeSeconds: null,
        progressLabel: null,
        activeDeliveryId: delivery.deliveryStatus === 'running' ? delivery.id : null,
        backend: delivery.targetMember.backend,
        harnessType: delivery.targetMember.harnessType,
        interruptSupported: delivery.targetMember.backend === 'remote_ssh',
        status: 'running',
      });
      continue;
    }

    existing.pendingCount += 1;
    if (delivery.deliveryStatus === 'pending') {
      existing.queuedCount += 1;
    } else {
      existing.runningCount += 1;
      existing.activeDeliveryId = delivery.id;
    }
    if (createdAtIso < existing.oldestPendingAt) {
      existing.oldestPendingAt = createdAtIso;
    }
    if (createdAtIso > existing.newestPendingAt) {
      existing.newestPendingAt = createdAtIso;
      existing.newestPendingAgeSeconds = Math.max(0, Math.floor((now - createdAtMs) / 1000));
    }
  }

  return Array.from(grouped.values())
    .map((item) => {
      const session = latestSessionByMemberId.get(item.memberId);
      const lastProgressAt = session?.lastHeartbeatAt?.toISOString() || null;
      const lastProgressAgeSeconds = session?.lastHeartbeatAt
        ? Math.max(0, Math.floor((now - session.lastHeartbeatAt.getTime()) / 1000))
        : null;
      const progressLabel = session?.lastError?.startsWith('progress:')
        ? session.lastError.replace(/^progress:/, '')
        : null;

      return {
        ...item,
        lastProgressAt,
        lastProgressAgeSeconds,
        progressLabel,
        interruptSupported: item.interruptSupported && item.runningCount > 0,
        status: (
          item.runningCount === 0
            ? 'queued'
            : item.newestPendingAgeSeconds >= 180 || ((lastProgressAgeSeconds ?? 0) >= 180)
            ? 'stalled'
            : 'running'
        ) as LiveRoomPendingReplyPayload['status'],
      };
    })
    .sort((left, right) => right.newestPendingAt.localeCompare(left.newestPendingAt));
};


