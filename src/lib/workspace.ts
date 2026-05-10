import { prisma } from '@/lib/prisma';
import {
  listLiveRoomPendingReplies,
  serializeLiveRoomMember,
  serializeLiveRoomSummary,
  type LiveRoomPendingReplyPayload,
} from '@/lib/live-room';
import type { WorkspaceChannel, WorkspaceDetail, WorkspaceSummary } from '@/types';

type WorkspaceStatus = WorkspaceSummary['workspaceStatus'];
type AttentionState = WorkspaceSummary['attentionState'];

const USER_ACTION_REQUEST_KINDS = new Set([
  'permission_request',
  'input_request',
  'choice_request',
  'workspace_issue',
]);

const deriveWorkspaceSignals = ({
  lifecycleStatus,
  taskStatus,
  pendingReplyCount,
  pendingActionCount,
  latestMessageSenderType,
}: {
  lifecycleStatus: 'active' | 'archived';
  taskStatus?: string | null;
  pendingReplyCount: number;
  pendingActionCount: number;
  latestMessageSenderType?: string | null;
}): {
  workspaceStatus: WorkspaceStatus;
  attentionState: AttentionState;
} => {
  if (lifecycleStatus === 'archived') {
    return {
      workspaceStatus: 'archived',
      attentionState: 'quiet',
    };
  }

  if (taskStatus === 'failed') {
    return {
      workspaceStatus: 'failed',
      attentionState: 'failed',
    };
  }

  if (pendingActionCount > 0) {
    return {
      workspaceStatus: 'waiting_for_you',
      attentionState: 'waiting_for_you',
    };
  }

  if (taskStatus === 'running' || pendingReplyCount > 0) {
    return {
      workspaceStatus: 'running',
      attentionState: latestMessageSenderType && latestMessageSenderType !== 'user' ? 'new_updates' : 'quiet',
    };
  }

  return {
    workspaceStatus: 'idle',
    attentionState: latestMessageSenderType && latestMessageSenderType !== 'user' ? 'new_updates' : 'quiet',
  };
};

const mapFeishuBindingsToChannels = (
  workspaceId: string,
  bindings: Array<{
    id: string;
    chatId: string;
    chatType: string;
    updatedAt: Date;
  }>
): WorkspaceChannel[] => {
  const webChannel: WorkspaceChannel = {
    id: `${workspaceId}:web_room`,
    workspaceId,
    kind: 'web_room',
    label: 'Web Workspace',
    externalId: workspaceId,
    status: 'connected',
  };

  const feishuChannels = bindings.map((binding) => ({
    id: binding.id,
    workspaceId,
    kind: 'feishu_chat' as const,
    label: binding.chatType === 'p2p' ? 'Feishu P2P' : 'Feishu Group',
    externalId: binding.chatId,
    status: 'connected' as const,
  }));

  return [webChannel, ...feishuChannels];
};

const buildWorkspaceSummary = ({
  room,
  pendingReplies,
}: {
  room: {
    id: string;
    title: string;
    description: string | null;
    currentTopic: string | null;
    mode: string;
    status: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
    currentSpeakerMemberId: string | null;
    currentSpeaker?: {
      displayName: string;
      agentRecord?: { userNickname: string | null } | null;
    } | null;
    members?: Array<unknown>;
    messages?: Array<{
      content: string;
      createdAt: Date;
      senderMember?: { memberType: string } | null;
    }>;
    feishuBindings: Array<{
      id: string;
      chatId: string;
      chatType: string;
      updatedAt: Date;
    }>;
    sourceTask?: {
      status: string;
      interactionRequests: Array<{
        requestKind: string;
        status: string;
      }>;
    } | null;
  };
  pendingReplies: LiveRoomPendingReplyPayload[];
}): WorkspaceSummary => {
  const liveRoomSummary = serializeLiveRoomSummary(room);
  const pendingActionCount =
    room.sourceTask?.interactionRequests.filter((request) =>
      request.status === 'pending' && USER_ACTION_REQUEST_KINDS.has(request.requestKind)
    ).length || 0;
  const latestMessage = room.messages?.[0] || null;
  const signals = deriveWorkspaceSignals({
    lifecycleStatus: room.status === 'archived' ? 'archived' : 'active',
    taskStatus: room.sourceTask?.status || null,
    pendingReplyCount: pendingReplies.length,
    pendingActionCount,
    latestMessageSenderType: latestMessage?.senderMember?.memberType || null,
  });

  return {
    ...liveRoomSummary,
    workspaceStatus: signals.workspaceStatus,
    attentionState: signals.attentionState,
    unreadCount: 0,
    lastActivityAt: latestMessage?.createdAt.toISOString() || room.updatedAt.toISOString(),
    lifecycleStatus: room.status === 'archived' ? 'archived' : 'active',
    linkedChannels: mapFeishuBindingsToChannels(room.id, room.feishuBindings),
  };
};

export async function listWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
  const rooms = await prisma.liveRoom.findMany({
    where: {
      status: {
        in: ['active', 'archived'],
      },
    },
    include: {
      currentSpeaker: {
        include: {
          agentRecord: true,
        },
      },
      members: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          senderMember: {
            select: {
              memberType: true,
            },
          },
        },
      },
      feishuBindings: {
        orderBy: {
          updatedAt: 'desc',
        },
      },
      sourceTask: {
        select: {
          status: true,
          interactionRequests: {
            where: {
              status: 'pending',
            },
            select: {
              requestKind: true,
              status: true,
            },
          },
        },
      },
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  const pendingReplyGroups = await Promise.all(
    rooms.map(async (room) => ({
      roomId: room.id,
      pendingReplies: await listLiveRoomPendingReplies(room.id),
    }))
  );
  const pendingReplyMap = new Map(pendingReplyGroups.map((entry) => [entry.roomId, entry.pendingReplies]));

  return rooms
    .map((room) =>
      buildWorkspaceSummary({
        room,
        pendingReplies: pendingReplyMap.get(room.id) || [],
      })
    )
    .sort((left, right) => {
      const priority = {
        waiting_for_you: 0,
        failed: 1,
        new_updates: 2,
        running: 3,
        quiet: 4,
      } as const;

      const leftPriority = priority[left.attentionState];
      const rightPriority = priority[right.attentionState];

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
    });
}

export async function getWorkspaceDetail(workspaceId: string): Promise<WorkspaceDetail | null> {
  const room = await prisma.liveRoom.findUnique({
    where: { id: workspaceId },
    include: {
      currentSpeaker: {
        include: {
          agentRecord: true,
        },
      },
      sourceTask: {
        select: {
          id: true,
          name: true,
          status: true,
          interactionRequests: {
            where: {
              status: 'pending',
            },
            select: {
              requestKind: true,
              status: true,
            },
          },
        },
      },
      members: {
        include: {
          gateway: true,
          agentRecord: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          senderMember: {
            select: {
              memberType: true,
            },
          },
        },
      },
      feishuBindings: {
        orderBy: {
          updatedAt: 'desc',
        },
      },
    },
  });

  if (!room) {
    return null;
  }

  const pendingReplies = await listLiveRoomPendingReplies(workspaceId);
  const summary = buildWorkspaceSummary({ room, pendingReplies });
  const pendingActionCount =
    room.sourceTask?.interactionRequests.filter((request) =>
      request.status === 'pending' && USER_ACTION_REQUEST_KINDS.has(request.requestKind)
    ).length || 0;

  return {
    ...summary,
    sourceTask: room.sourceTask
      ? {
          id: room.sourceTask.id,
          name: room.sourceTask.name,
        }
      : null,
    pendingReplyCount: pendingReplies.reduce((total, reply) => total + reply.pendingCount, 0),
    pendingReplyTargetNames: pendingReplies.map((reply) => reply.displayName),
    pendingReplies,
    members: room.members.map(serializeLiveRoomMember),
    pendingActionCount,
  };
}
