import { getMentionAliases, type LiveRoomMemberWithAgent } from '@/lib/agent-identity';
import { prisma } from '@/lib/prisma';

export const DEFAULT_LIVE_ROOM_HANDOFF_LIMIT = 4;
export const MAX_LIVE_ROOM_HANDOFF_LIMIT = 32;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MENTION_BOUNDARY = `[\\s,.;:!?\\/()\\[\\]{}"'，。；：！？】【、】【（）《》]`;
const HANDOFF_PREFIX = `(^|${MENTION_BOUNDARY})`;

type HandoffMember = {
  id: string;
  displayName: string;
  userNickname?: string | null;
  shortAlias?: string | null;
  agentNameSnapshot?: string | null;
  harnessType?: string | null;
  backend?: string | null;
  roleLabel?: string | null;
  gateway?: { name: string | null } | null;
  agentRecord?: {
    userNickname?: string | null;
    hostname?: string | null;
  } | null;
};

export type LiveRoomHandoffIntent =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: 'multiple_targets' | 'unknown_target' }
  | { kind: 'target'; targetMemberId: string };

export const parseLiveRoomHandoffLimit = (value?: string | number | null) => {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LIVE_ROOM_HANDOFF_LIMIT
    ? parsed
    : null;
};

export const detectLiveRoomHandoffIntent = ({
  content,
  members,
  senderMemberId,
}: {
  content: string;
  members: HandoffMember[];
  senderMemberId?: string | null;
}): LiveRoomHandoffIntent => {
  const dollarPositions = Array.from(content.matchAll(new RegExp(`${HANDOFF_PREFIX}\\$(?=\\S)`, 'g')))
    .map((match) => (match.index ?? 0) + match[1].length);
  if (dollarPositions.length === 0) return { kind: 'none' };

  const matches = new Map<number, { memberId: string; aliasLength: number }>();
  for (const member of members) {
    if (member.id === senderMemberId) continue;
    for (const alias of getMentionAliases(member as LiveRoomMemberWithAgent)) {
      const trimmed = alias.trim();
      if (!trimmed) continue;
      const pattern = new RegExp(
        `${HANDOFF_PREFIX}\\$${escapeRegExp(trimmed)}(?=${MENTION_BOUNDARY}|$)`,
        'gi',
      );
      for (const match of Array.from(content.matchAll(pattern))) {
        const position = (match.index ?? 0) + match[1].length;
        const existing = matches.get(position);
        if (!existing || trimmed.length > existing.aliasLength) {
          matches.set(position, { memberId: member.id, aliasLength: trimmed.length });
        }
      }
    }
  }

  const resolvedTargets = new Set(
    dollarPositions.map((position) => matches.get(position)?.memberId).filter(Boolean),
  );
  if (dollarPositions.length > 1 || resolvedTargets.size > 1) {
    return { kind: 'invalid', reason: 'multiple_targets' };
  }
  const targetMemberId = matches.get(dollarPositions[0])?.memberId;
  return targetMemberId
    ? { kind: 'target', targetMemberId }
    : { kind: 'invalid', reason: 'unknown_target' };
};

export const ensureLiveRoomHandoffRoot = async ({
  messageId,
  handoffLimit,
}: {
  messageId: string;
  handoffLimit: number;
}) => {
  const snapshot = Math.min(
    Math.max(handoffLimit, 0),
    MAX_LIVE_ROOM_HANDOFF_LIMIT,
  );
  await prisma.liveRoomMessage.updateMany({
    where: { id: messageId, handoffLimitSnapshot: null },
    data: {
      handoffRootMessageId: messageId,
      handoffLimitSnapshot: snapshot,
    },
  });
  return prisma.liveRoomMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      handoffLimitSnapshot: true,
      handoffCount: true,
    },
  });
};

export const recordRejectedLiveRoomHandoff = async ({
  assistantMessageId,
  status,
}: {
  assistantMessageId: string;
  status: 'rejected_multiple_targets' | 'rejected_unknown_target';
}) => prisma.liveRoomMessage.updateMany({
  where: { id: assistantMessageId, handoffClaimStatus: null },
  data: { handoffClaimStatus: status },
});

export type LiveRoomHandoffClaimResult =
  | { status: 'duplicate' }
  | { status: 'rejected_disabled' | 'rejected_budget_exhausted' | 'rejected_invalid_root' }
  | {
      status: 'accepted';
      delivery: {
        id: string;
        deliveryStatus: string;
        fallbackReason: string | null;
      } | null;
    };

export const claimLiveRoomHandoff = async ({
  assistantMessageId,
  rootMessageId,
  targetMemberId,
  roomId,
}: {
  assistantMessageId: string;
  rootMessageId: string;
  targetMemberId: string;
  roomId: string;
}): Promise<LiveRoomHandoffClaimResult> => prisma.$transaction(async (tx) => {
  const reserved = await tx.liveRoomMessage.updateMany({
    where: { id: assistantMessageId, handoffClaimStatus: null },
    data: {
      handoffClaimStatus: 'claiming',
      handoffRootMessageId: rootMessageId,
      handoffTargetMemberId: targetMemberId,
    },
  });
  if (reserved.count === 0) return { status: 'duplicate' };

  const root = await tx.liveRoomMessage.findFirst({
    where: { id: rootMessageId, roomId },
    select: {
      handoffLimitSnapshot: true,
    },
  });
  if (!root || root.handoffLimitSnapshot === null) {
    await tx.liveRoomMessage.update({
      where: { id: assistantMessageId },
      data: { handoffClaimStatus: 'rejected_invalid_root' },
    });
    return { status: 'rejected_invalid_root' };
  }

  if (root.handoffLimitSnapshot === 0) {
    await tx.liveRoomMessage.update({
      where: { id: assistantMessageId },
      data: { handoffClaimStatus: 'rejected_disabled' },
    });
    return { status: 'rejected_disabled' };
  }

  const budget = await tx.liveRoomMessage.updateMany({
    where: {
      id: rootMessageId,
      roomId,
      handoffCount: { lt: root.handoffLimitSnapshot },
    },
    data: { handoffCount: { increment: 1 } },
  });
  if (budget.count === 0) {
    await tx.liveRoomMessage.update({
      where: { id: assistantMessageId },
      data: { handoffClaimStatus: 'rejected_budget_exhausted' },
    });
    return { status: 'rejected_budget_exhausted' };
  }

  const target = await tx.liveRoomMember.findFirst({
    where: { id: targetMemberId, roomId },
    select: {
      id: true,
      canReply: true,
      joinStatus: true,
      presenceStatus: true,
    },
  });
  const fallbackReason = !target
    ? 'Handoff target is no longer a room member'
    : target.joinStatus !== 'joined'
    ? 'Handoff target was removed from the room'
    : !target.canReply
    ? 'Handoff target was stopped'
    : target.presenceStatus === 'offline'
    ? 'Handoff target is offline'
    : null;
  const delivery = target
    ? await tx.liveRoomDelivery.create({
        data: {
          roomMessageId: assistantMessageId,
          targetMemberId,
          handoffRootMessageId: rootMessageId,
          deliveryStatus: fallbackReason ? 'failed' : 'pending',
          fallbackReason,
          acknowledgedAt: fallbackReason ? new Date() : null,
        },
        select: {
          id: true,
          deliveryStatus: true,
          fallbackReason: true,
        },
      })
    : null;

  await tx.liveRoomMessage.update({
    where: { id: assistantMessageId },
    data: { handoffClaimStatus: 'accepted' },
  });
  return { status: 'accepted', delivery };
});
