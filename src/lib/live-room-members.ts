import { prisma } from "@/lib/prisma";
import { getCodexProviderContextUsage } from "@/lib/codex-telemetry";
import { getKimiCodeProviderContextUsage } from "@/lib/real-agents/kimi-code-telemetry";
import { getAntigravityProviderContextUsage } from "@/lib/real-agents/antigravity-context";
import { deriveGatewayHarnessOptions } from "@/lib/acpx/catalog";
import { ensureTaskSession } from "@/lib/acpx/session";
import { DEFAULT_ACPX_PERMISSION_CONFIG, getPermissionProfileLabel } from "@/lib/acpx/permissions";
import { resolveLiveRoomMemberPermission } from "@/lib/live-room-permissions";
import { buildTaskRoomTranscriptFromMessages, ensureTaskChatRoom, parseTaskRoomSessionResetMarker, sliceTaskRoomMessagesForParticipant } from "@/lib/task-room";
import { getTaskRoomParticipantTargetKey } from "@/lib/task-room-targets";
import type { AcpxExecutionBackend, AcpxParticipantRequest } from "@/lib/acpx/types";
import { encodeLiveRoomRoleLabel, extractRemoteHostIdFromRoleLabel, getLiveRoomParticipantContinuationKey, type LiveRoomCatalogAgent, type LiveRoomMemberContextWatermarkPayload, type LiveRoomMemberPayload } from "@/lib/live-room-types";

const CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD = 60;
const CONTEXT_HARD_EVENT_THRESHOLD = 400;
const CONTEXT_HARD_TRANSCRIPT_LIMIT = 4000;
const CONTEXT_USAGE_ELEVATED_PERCENTAGE = 60;
const CONTEXT_USAGE_HIGH_PERCENTAGE = 85;

function normalizeLiveRoomAgentSelector(value: string): string {
  return value.trim().toLowerCase();
}

function buildLiveRoomAgentSelectorAliases(agent: LiveRoomCatalogAgent) {
  const aliases = new Set<string>();
  const add = (value?: string | null) => {
    const normalized = value ? normalizeLiveRoomAgentSelector(value) : '';
    if (normalized) {
      aliases.add(normalized);
    }
  };

  add(agent.id);
  add(agent.label);
  add(agent.agentName);
  add(agent.userNickname);
  add(agent.runtimeAgentId);

  if (agent.backend === 'remote_ssh') {
    add(`${agent.gatewayName}:${agent.harnessType}`);
    add(`${agent.gatewayName}/${agent.harnessType}`);
    add(`${agent.harnessType}@${agent.gatewayName}`);
    add(`${agent.gatewayId}:${agent.harnessType}`);
    add(`${agent.gatewayId}/${agent.harnessType}`);
    add(`${agent.harnessType}@${agent.gatewayId}`);
  }

  if (agent.backend === 'platform_local') {
    add(`local:${agent.harnessType}`);
    add(`platform-local:${agent.harnessType}`);
    if (agent.hostname) {
      add(`platform-local:${agent.hostname}:${agent.harnessType}`);
      add(`platform_local:${agent.hostname}:${agent.harnessType}`);
      add(`${agent.hostname}:${agent.harnessType}`);
      add(`${agent.hostname}/${agent.harnessType}`);
      add(`${agent.harnessType}@${agent.hostname}`);
    }
  }

  if (agent.backend === 'gateway_openclaw') {
    add(`${agent.gatewayName}:${agent.harnessType}`);
    add(`${agent.gatewayName}/${agent.harnessType}`);
    add(`${agent.harnessType}@${agent.gatewayName}`);
    add(`${agent.gatewayId}:${agent.harnessType}`);
    add(`${agent.gatewayId}/${agent.harnessType}`);
    add(`${agent.harnessType}@${agent.gatewayId}`);
  }

  return aliases;
}

export async function resolveLiveRoomAgentSelectors(selectors: string[]): Promise<string[]> {
  if (selectors.length === 0) {
    return [];
  }

  const agents = await listLiveRoomCatalogAgents();
  const aliasMap = new Map<string, string[]>();

  for (const agent of agents) {
    for (const alias of Array.from(buildLiveRoomAgentSelectorAliases(agent))) {
      const existing = aliasMap.get(alias) || [];
      existing.push(agent.id);
      aliasMap.set(alias, existing);
    }
  }

  const resolvedIds: string[] = [];
  const unknown: string[] = [];
  const ambiguous: Array<{ selector: string; matches: string[] }> = [];

  for (const selector of selectors) {
    const normalized = normalizeLiveRoomAgentSelector(selector);
    const matches = Array.from(new Set(aliasMap.get(normalized) || []));

    if (matches.length === 1) {
      resolvedIds.push(matches[0]);
      continue;
    }

    if (matches.length > 1) {
      ambiguous.push({ selector, matches });
      continue;
    }

    unknown.push(selector);
  }

  if (unknown.length > 0 || ambiguous.length > 0) {
    const parts: string[] = [];

    if (unknown.length > 0) {
      parts.push(`Unknown agent selectors: ${unknown.join(', ')}`);
    }

    if (ambiguous.length > 0) {
      parts.push(
        ...ambiguous.map((item) => `Ambiguous agent selector "${item.selector}": ${item.matches.join(', ')}`)
      );
    }

    parts.push('可用短写示例：local:codex, platform-local:hello:claude, TX-server:claude, TX-server/claude, claude@TX-server');
    parts.push('也可以先发送 /ap agents 查看完整 agent ID。');
    throw new Error(parts.join('\n'));
  }

  return Array.from(new Set(resolvedIds));
}

export async function addCatalogAgentsToLiveRoom(roomId: string, selectedAgentIds: string[]) {
  if (selectedAgentIds.length === 0) {
    return [];
  }

  const availableAgents = await listLiveRoomCatalogAgents();
  const selectedAgents = availableAgents.filter((agent) => selectedAgentIds.includes(agent.id));

  if (selectedAgents.length !== selectedAgentIds.length) {
    const foundIds = new Set(selectedAgents.map((agent) => agent.id));
    const missingIds = selectedAgentIds.filter((id) => !foundIds.has(id));
    throw new Error(`Unknown agent ids: ${missingIds.join(', ')}`);
  }

  const existingMembers = await prisma.liveRoomMember.findMany({
    where: { roomId },
  });

  const maxSort = await prisma.liveRoomMember.aggregate({
    where: { roomId },
    _max: { sortOrder: true },
  });
  let nextSortOrder = (maxSort._max.sortOrder || 0) + 1;

  const createdMembers = [] as Awaited<ReturnType<typeof prisma.liveRoomMember.create>>[];

  for (const agent of selectedAgents) {
    const existing = existingMembers.find((member) => {
      if (member.agentRecordId !== (agent.agentRecordId || null)) return false;
      if (member.backend !== agent.backend) return false;
      if (member.harnessType !== agent.harnessType) return false;
      if (member.runtimeAgentId !== (agent.runtimeAgentId || null)) return false;
      if (agent.backend === 'remote_ssh') {
        return extractRemoteHostIdFromRoleLabel(member.roleLabel) === agent.gatewayId;
      }
      return member.gatewayId === (agent.gatewayId === 'platform-local' ? null : agent.gatewayId);
    });

    if (existing) {
      continue;
    }

    const created = await prisma.liveRoomMember.create({
      data: {
        roomId,
        agentRecordId: agent.agentRecordId || null,
        gatewayId:
          agent.backend === 'gateway_openclaw'
            ? (agent.gatewayId === 'platform-local' ? null : agent.gatewayId)
            : null,
        memberType:
          agent.backend === 'gateway_openclaw'
            ? 'gateway_agent'
            : agent.backend === 'remote_ssh'
            ? 'remote_agent'
            : 'local_agent',
        displayName: agent.userNickname || agent.agentName || agent.label,
        agentNameSnapshot: agent.userNickname || agent.agentName || agent.label,
        harnessType: agent.harnessType,
        backend: agent.backend,
        runtimeAgentId: agent.runtimeAgentId || null,
        roleLabel: encodeLiveRoomRoleLabel({
          backend: agent.backend,
          label: agent.label,
          remoteHostId: agent.backend === 'remote_ssh' ? agent.gatewayId : null,
        }),
        joinStatus: 'joined',
        presenceStatus: agent.status === 'online' ? 'online' : 'idle',
        canReply: true,
        sortOrder: nextSortOrder++,
      },
    });

    createdMembers.push(created);
  }

  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    select: { currentSpeakerMemberId: true },
  });

  if (createdMembers.length > 0 && room && !room.currentSpeakerMemberId) {
    await prisma.liveRoom.update({
      where: { id: roomId },
      data: {
        currentSpeakerMemberId: createdMembers[0].id,
      },
    });
  }

  return createdMembers;
}

const toCatalogAgentId = (agent: Awaited<ReturnType<typeof deriveGatewayHarnessOptions>>[number]) =>
  `${agent.executionBackend}:${agent.gatewayId}:${agent.runtimeAgentId || agent.agentId || agent.harnessType}`;

export const listLiveRoomCatalogAgents = async (): Promise<LiveRoomCatalogAgent[]> => {
  const options = await deriveGatewayHarnessOptions();

  return options.map((option) => ({
    id: toCatalogAgentId(option),
    agentRecordId: option.executionBackend === 'gateway_openclaw' ? option.agentId || null : null,
    gatewayId: option.gatewayId,
    gatewayName: option.gatewayName,
    backend: option.executionBackend,
    harnessType: option.harnessType,
    label: option.harnessLabel,
    agentName: option.agentName || null || undefined,
    userNickname: option.userNickname || null,
    hostname: option.hostname || null,
    runtimeAgentId: option.runtimeAgentId || option.agentId || undefined,
    status: option.status,
  }));
};

export const serializeLiveRoomMember = (member: {
  id: string;
  roomId: string;
  memberType: string;
  displayName: string;
  agentNameSnapshot: string | null;
  harnessType: string | null;
  backend: string | null;
  runtimeAgentId: string | null;
  roleLabel: string | null;
  role: string;
  joinStatus: string;
  presenceStatus: string;
  canReply: boolean;
  sortOrder: number;
  gatewayId: string | null;
  agentRecordId: string | null;
  acpxPermissionConfig?: string | null;
  codexModel?: string | null;
  codexReasoningEffort?: string | null;
  gateway?: { name: string } | null;
  agentRecord?: {
    userNickname: string | null;
    name: string;
  } | null;
}): LiveRoomMemberPayload => {
  // Prefer the current nickname from Agent record over the stored snapshot
  const currentNickname = member.agentRecord?.userNickname || null;
  const displayName = currentNickname || member.displayName;
  const agentNameSnapshot = currentNickname || member.agentNameSnapshot;

  return {
    id: member.id,
    roomId: member.roomId,
    memberType: member.memberType,
    displayName,
    agentNameSnapshot,
    harnessType: member.harnessType,
    backend: member.backend,
    runtimeAgentId: member.runtimeAgentId,
    roleLabel: member.roleLabel,
    role: member.role,
    joinStatus: member.joinStatus,
    presenceStatus: member.presenceStatus,
    canReply: member.canReply,
    sortOrder: member.sortOrder,
    gatewayId: member.gatewayId,
    gatewayName:
      member.gateway?.name
      || (member.backend === 'remote_ssh' ? extractRemoteHostIdFromRoleLabel(member.roleLabel) : null),
    agentRecordId: member.agentRecordId,
    codexModel: member.codexModel,
    codexReasoningEffort: member.codexReasoningEffort,
    permissionProfile: null,
    permissionLabel: null,
    contextWatermark: null,
  };
};

const getContextWatermarkPolicyStatus = ({
  messageCount,
  eventCount,
  transcriptChars,
}: {
  messageCount: number;
  eventCount: number;
  transcriptChars: number;
}): LiveRoomMemberContextWatermarkPayload['policyStatus'] => {
  if (
    messageCount >= CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD
    || eventCount >= CONTEXT_HARD_EVENT_THRESHOLD
    || transcriptChars >= CONTEXT_HARD_TRANSCRIPT_LIMIT
  ) {
    return 'warning';
  }

  return 'normal';
};

const getContextWatermarkUsageStatus = (
  usagePercentage: number | null,
  source: LiveRoomMemberContextWatermarkPayload['source']
): LiveRoomMemberContextWatermarkPayload['usageStatus'] => {
  if (source === 'not_applicable') return 'not_applicable';
  if (usagePercentage == null) return 'unknown';
  if (usagePercentage >= CONTEXT_USAGE_HIGH_PERCENTAGE) {
    return 'high';
  }

  if (usagePercentage >= CONTEXT_USAGE_ELEVATED_PERCENTAGE) {
    return 'elevated';
  }

  return 'light';
};

const getContextWatermarkPolicyLabel = (
  policyStatus: LiveRoomMemberContextWatermarkPayload['policyStatus'],
  source: LiveRoomMemberContextWatermarkPayload['source']
) => {
  if (source === 'not_applicable') return 'not applicable';
  if (source === 'unknown') {
    return policyStatus === 'warning' ? 'agent signal warning' : 'context unknown';
  }
  if (policyStatus === 'critical') {
    return 'reset now';
  }

  if (policyStatus === 'warning') {
    return 'warning';
  }

  return 'within policy';
};

const getPermissionProfileSummary = (
  member: { acpxPermissionConfig?: string | null },
  sourceTask?: { acpxPermissionConfig?: string | null } | null
) => {
  const config = resolveLiveRoomMemberPermission(
    member.acpxPermissionConfig,
    sourceTask?.acpxPermissionConfig
  );
  return {
    permissionProfile: config.profile,
    permissionLabel: getPermissionProfileLabel(config.profile),
  };
};

export const getLiveRoomMemberContextWatermark = async ({
  member,
  sourceTask,
}: {
  member: {
    id: string;
    displayName: string;
    backend?: string | null;
    harnessType?: string | null;
    gatewayId?: string | null;
    roleLabel?: string | null;
    role?: string | null;
    runtimeAgentId?: string | null;
    codexModel?: string | null;
    codexReasoningEffort?: string | null;
    gateway?: { id?: string | null; name?: string | null } | null;
  };
  sourceTask?: {
    id: string;
    name: string;
  } | null;
}): Promise<LiveRoomMemberContextWatermarkPayload | null> => {
  if (!sourceTask || member.backend == null || member.harnessType == null) {
    return null;
  }

  const participant = buildLiveRoomAcpxParticipant({
    id: member.id,
    displayName: member.displayName,
    backend: member.backend,
    harnessType: member.harnessType,
    gatewayId: member.backend === 'remote_ssh'
      ? extractRemoteHostIdFromRoleLabel(member.roleLabel) || member.gateway?.id || member.gatewayId
      : member.gatewayId,
    gatewayName: member.gateway?.name || null,
    runtimeAgentId: member.runtimeAgentId,
    role: member.role,
    codexModel: member.codexModel,
    codexReasoningEffort: member.codexReasoningEffort,
  });
  const participantKey = getTaskRoomParticipantTargetKey(participant);
  const participantUserId = `${getLiveRoomParticipantContinuationKey(member.id)}:speaker`;
  const taskRoom = await ensureTaskChatRoom(sourceTask.id, sourceTask.name);
  const taskRoomMessages = await prisma.message.findMany({
    where: { roomId: taskRoom.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      userId: true,
      userName: true,
      content: true,
      createdAt: true,
      targetType: true,
      targetParticipantKey: true,
      targetParticipantLabel: true,
    },
  });
  const visibleMessages = sliceTaskRoomMessagesForParticipant(
    taskRoomMessages,
    participantKey,
    member.id,
    participantUserId
  );
  const { transcript, promptCandidates } = buildTaskRoomTranscriptFromMessages(visibleMessages);
  const latestResetAt = [...taskRoomMessages]
    .reverse()
    .find((message) => {
      const resetMarker = parseTaskRoomSessionResetMarker(message.content);
      return resetMarker && (!resetMarker.memberId || resetMarker.memberId === member.id);
    })
    ?.createdAt || null;
  const continuationKey = getLiveRoomParticipantContinuationKey(member.id);
  const providerHarness = member.backend === 'platform_local'
    && (member.harnessType === 'codex' || member.harnessType === 'kimi-code' || member.harnessType === 'antigravity')
    ? member.harnessType
    : null;
  const [eventCount, providerParticipant] = await Promise.all([
    prisma.taskRunEvent.count({
      where: {
        taskRun: {
          taskId: sourceTask.id,
        },
        participant: {
          is: {
            controlMetadata: {
              contains: `"continuationKey":"${continuationKey}"`,
            },
          },
        },
        ...(latestResetAt ? { createdAt: { gt: latestResetAt } } : {}),
      },
    }),
    providerHarness
      ? prisma.taskRunParticipant.findFirst({
          where: {
            taskRun: { taskId: sourceTask.id },
            executionBackend: 'platform_local',
            harnessType: providerHarness,
            AND: [
              { controlMetadata: { contains: `"continuationKey":"${continuationKey}"` } },
              {
                controlMetadata: {
                  contains: providerHarness === 'codex'
                    ? '"codexTokenUsage"'
                    : providerHarness === 'kimi-code'
                    ? '"kimiCodeContextUsage"'
                    : '"antigravityContextUsage"',
                },
              },
            ],
            ...(latestResetAt ? { createdAt: { gt: latestResetAt } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          select: { controlMetadata: true },
        })
      : Promise.resolve(null),
  ]);
  const antigravityRunUsage = member.backend === 'platform_local' && member.harnessType === 'antigravity'
    ? getAntigravityProviderContextUsage(providerParticipant?.controlMetadata)
    : null;
  const providerUsage = providerHarness === 'codex'
    ? getCodexProviderContextUsage(providerParticipant?.controlMetadata)
    : providerHarness === 'kimi-code'
    ? getKimiCodeProviderContextUsage(providerParticipant?.controlMetadata)
    : null;
  const source: LiveRoomMemberContextWatermarkPayload['source'] = providerUsage
    ? 'provider'
    : member.backend === 'platform_local' && member.harnessType === 'antigravity'
    ? 'not_applicable'
    : member.backend !== 'platform_local'
    ? 'not_applicable'
    : 'unknown';

  const messageCount = promptCandidates.length;
  const transcriptChars = transcript.length;
  const messageRatio = messageCount / CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD;
  const eventRatio = eventCount / CONTEXT_HARD_EVENT_THRESHOLD;
  const transcriptRatio = transcriptChars / CONTEXT_HARD_TRANSCRIPT_LIMIT;
  const estimatedDominantReason = (
    transcriptRatio >= messageRatio && transcriptRatio >= eventRatio
      ? 'transcript'
      : eventRatio >= messageRatio
      ? 'events'
      : 'messages'
  ) as Exclude<LiveRoomMemberContextWatermarkPayload['dominantReason'], 'provider'>;
  const estimatedDominantLabel =
    estimatedDominantReason === 'transcript'
      ? 'transcript'
      : estimatedDominantReason === 'events'
      ? 'events'
      : 'messages';
  const usagePercentage = providerUsage?.usagePercentage ?? null;
  const policyStatus = providerUsage
    ? providerUsage.usagePercentage >= CONTEXT_USAGE_HIGH_PERCENTAGE
      ? 'critical'
      : providerUsage.usagePercentage >= CONTEXT_USAGE_ELEVATED_PERCENTAGE
      ? 'warning'
      : 'normal'
    : source === 'not_applicable'
    ? 'normal'
    : getContextWatermarkPolicyStatus({ messageCount, eventCount, transcriptChars });
  const usageStatus = getContextWatermarkUsageStatus(usagePercentage, source);

  return {
    source,
    usagePercentage,
    usageStatus,
    policyStatus,
    policyLabel: getContextWatermarkPolicyLabel(policyStatus, source),
    dominantReason: providerUsage ? 'provider' : estimatedDominantReason,
    dominantLabel: providerUsage
      ? 'provider'
      : member.backend === 'platform_local' && member.harnessType === 'antigravity'
      ? antigravityRunUsage
        ? `last run usage: ${antigravityRunUsage.lastRunInputTokens} tokens`
        : 'fresh conversation per turn'
      : source === 'not_applicable'
      ? 'fresh conversation per turn'
      : `agent signal · ${estimatedDominantLabel}`,
    ...(providerUsage
      ? {
          usedTokens: providerUsage.usedTokens,
          contextWindow: providerUsage.contextWindow,
        }
      : antigravityRunUsage
      ? {
          usedTokens: antigravityRunUsage.lastRunInputTokens,
          contextWindow: antigravityRunUsage.contextWindow,
        }
      : {}),
    recommendedAction:
      source === 'not_applicable'
        ? 'Each turn starts a fresh conversation; no session reset is needed.'
        : source === 'unknown'
        ? policyStatus === 'warning'
          ? 'Provider context is unknown; inspect agent activity and telemetry.'
          : 'Provider context is unknown; no context reset recommendation.'
        : policyStatus === 'critical'
        ? 'Finish the current step, then reset now with /ap new-session.'
        : policyStatus === 'warning'
        ? 'Consider /ap new-session soon.'
        : 'No action needed.',
    messageCount,
    eventCount,
    transcriptChars,
    remainingMessages: Math.max(0, CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD - messageCount),
    remainingEvents: Math.max(0, CONTEXT_HARD_EVENT_THRESHOLD - eventCount),
    remainingTranscriptChars: Math.max(0, CONTEXT_HARD_TRANSCRIPT_LIMIT - transcriptChars),
  };
};

export const serializeLiveRoomMemberWithContext = async ({
  member,
  sourceTask,
}: {
  member: Parameters<typeof serializeLiveRoomMember>[0];
  sourceTask?: {
    id: string;
    name: string;
    acpxPermissionConfig?: string | null;
  } | null;
}): Promise<LiveRoomMemberPayload> => {
  const base = serializeLiveRoomMember(member);
  const permissionSummary = getPermissionProfileSummary(member, sourceTask);
  const contextWatermark = await getLiveRoomMemberContextWatermark({
    member,
    sourceTask,
  });

  return {
    ...base,
    ...permissionSummary,
    contextWatermark,
  };
};

export const serializeLiveRoomMembersWithContext = async ({
  members,
  sourceTask,
}: {
  members: Parameters<typeof serializeLiveRoomMember>[0][];
  sourceTask?: {
    id: string;
    name: string;
    acpxPermissionConfig?: string | null;
  } | null;
}) => Promise.all(members.map((member) => serializeLiveRoomMemberWithContext({ member, sourceTask })));

export const buildLiveRoomAcpxParticipant = (member: {
  id: string;
  displayName: string;
  backend?: string | null;
  harnessType?: string | null;
  gatewayId?: string | null;
  gatewayName?: string | null;
  runtimeAgentId?: string | null;
  role?: string | null;
  codexModel?: string | null;
  codexReasoningEffort?: string | null;
}): AcpxParticipantRequest => ({
  gatewayId:
    member.backend === 'platform_local'
      ? 'platform-local'
      : member.gatewayId || 'platform-local',
  gatewayName:
    member.backend === 'platform_local'
      ? 'Platform Local'
      : member.gatewayName || member.gatewayId || 'Gateway',
  executionBackend: (member.backend || 'platform_local') as AcpxExecutionBackend,
  harnessType: member.harnessType || 'codex',
  harnessLabel: member.harnessType || 'agent',
  role: member.role || 'custom',
  agentId: member.runtimeAgentId || undefined,
  agentName: member.displayName,
  continuationKey: getLiveRoomParticipantContinuationKey(member.id),
  model: member.codexModel || undefined,
  reasoningEffort: member.codexReasoningEffort || undefined,
});

export const ensureLiveRoomUserMember = async (roomId: string) => {
  const existing = await prisma.liveRoomMember.findFirst({
    where: {
      roomId,
      memberType: 'user',
      displayName: '你',
    },
  });

  if (existing) {
    return existing;
  }

  const maxSort = await prisma.liveRoomMember.aggregate({
    where: { roomId },
    _max: { sortOrder: true },
  });

  return prisma.liveRoomMember.create({
    data: {
      roomId,
      memberType: 'user',
      displayName: '你',
      canReply: false,
      sortOrder: (maxSort._max.sortOrder || 0) + 1,
      presenceStatus: 'online',
    },
  });
};

export const syncLiveRoomSourceTask = async (roomId: string) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        include: {
          gateway: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
      sourceTask: {
        include: {
          currentTaskSession: true,
        },
      },
    },
  });

  if (!room) {
    return null;
  }

  const workingDirectoryRows = await prisma.$queryRaw<Array<{ workingDirectory: string | null }>>`
    SELECT "workingDirectory"
    FROM "LiveRoom"
    WHERE "id" = ${roomId}
    LIMIT 1
  `;
  const workingDirectory = workingDirectoryRows[0]?.workingDirectory || null;

  const participants = room.members
    .filter((member) => member.canReply)
    .map((member) => buildLiveRoomAcpxParticipant({
      id: member.id,
      displayName: member.displayName,
      backend: member.backend,
      harnessType: member.harnessType,
      gatewayId: member.backend === 'remote_ssh'
        ? extractRemoteHostIdFromRoleLabel(member.roleLabel) || member.gatewayId
        : member.gatewayId,
      gatewayName: member.gateway?.name || null,
      runtimeAgentId: member.runtimeAgentId,
      role: member.role,
      codexModel: member.codexModel,
      codexReasoningEffort: member.codexReasoningEffort,
    }));

  if (participants.length === 0) {
    return room.sourceTask || null;
  }

  const taskName = `Live Room · ${room.title}`;
  const taskDescription = room.currentTopic
    ? `Backs live room "${room.title}". Current topic: ${room.currentTopic}`
    : `Backs live room "${room.title}".`;
  const taskDataBase = {
    name: taskName,
    description: taskDescription,
    executionMode: 'acpx',
    acpxParticipants: JSON.stringify(participants),
    workingDirectory: workingDirectory ?? room.sourceTask?.workingDirectory ?? undefined,
    result: JSON.stringify({
      executionMode: 'acpx',
      source: 'live_room',
      liveRoomId: room.id,
      participantCount: participants.length,
    }),
  };

  const sourceTask = room.sourceTask
    ? await prisma.task.update({
        where: { id: room.sourceTask.id },
        // acpxPermissionConfig is intentionally excluded: it may have been
        // updated by /ap grant or /ap new-session and must not be reset here.
        data: taskDataBase,
        include: {
          currentTaskSession: true,
        },
      })
    : await prisma.task.create({
        data: {
          ...taskDataBase,
          acpxPermissionConfig: JSON.stringify(DEFAULT_ACPX_PERMISSION_CONFIG),
        },
        include: {
          currentTaskSession: true,
        },
      });

  if (room.sourceTaskId !== sourceTask.id) {
    await prisma.liveRoom.update({
      where: { id: room.id },
      data: {
        sourceTaskId: sourceTask.id,
      },
    });
  }

  await ensureTaskSession(sourceTask.id, {
    taskName: sourceTask.name,
    metadata: {
      source: 'live_room',
      liveRoomId: room.id,
      participantCount: participants.length,
    },
  });
  await ensureTaskChatRoom(sourceTask.id, sourceTask.name);

  return prisma.task.findUnique({
    where: { id: sourceTask.id },
    include: {
      currentTaskSession: true,
    },
  });
};
