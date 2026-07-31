import { getLiveRoomMemberContextWatermark } from '@/lib/live-room-members';

export const DEFAULT_WORKFLOW_ROTATION_THRESHOLDS = {
  checkpointPreparationPercentage: 65,
  rotationPendingPercentage: 70,
  highPriorityPercentage: 85,
} as const;

export type WorkflowRotationThresholds = {
  checkpointPreparationPercentage: number;
  rotationPendingPercentage: number;
  highPriorityPercentage: number;
};

export type WorkflowRoomWatermark = {
  memberId: string;
  memberName: string;
  harnessType: string | null;
  usagePercentage: number | null;
  source: 'provider' | 'not_applicable' | 'unknown';
  label: string;
};

export type WorkflowRotationDecision = {
  action: 'reuse' | 'prepare_checkpoint' | 'rotation_pending' | 'warning_only';
  maximumUsagePercentage: number | null;
  highPriority: boolean;
  dominant: WorkflowRoomWatermark | null;
  samples: WorkflowRoomWatermark[];
};

const percentage = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function parseWorkflowRotationThresholds(config: unknown): WorkflowRotationThresholds {
  const value = config && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const thresholds = {
    checkpointPreparationPercentage: percentage(
      value.checkpoint_preparation_percentage,
      DEFAULT_WORKFLOW_ROTATION_THRESHOLDS.checkpointPreparationPercentage,
    ),
    rotationPendingPercentage: percentage(
      value.rotation_pending_percentage,
      DEFAULT_WORKFLOW_ROTATION_THRESHOLDS.rotationPendingPercentage,
    ),
    highPriorityPercentage: percentage(
      value.high_priority_percentage,
      DEFAULT_WORKFLOW_ROTATION_THRESHOLDS.highPriorityPercentage,
    ),
  };
  if (
    thresholds.checkpointPreparationPercentage < 0
    || thresholds.checkpointPreparationPercentage >= thresholds.rotationPendingPercentage
    || thresholds.rotationPendingPercentage >= thresholds.highPriorityPercentage
    || thresholds.highPriorityPercentage > 100
  ) {
    throw new Error('workflow session_rotation thresholds must satisfy 0 <= checkpoint < rotation < high <= 100');
  }
  return thresholds;
}

export function decideWorkflowRoomRotation(
  samples: WorkflowRoomWatermark[],
  thresholds: WorkflowRotationThresholds = DEFAULT_WORKFLOW_ROTATION_THRESHOLDS,
): WorkflowRotationDecision {
  const trustworthy = samples.filter((sample) => sample.usagePercentage !== null);
  const dominant = trustworthy.reduce<WorkflowRoomWatermark | null>(
    (current, sample) => !current || sample.usagePercentage! > current.usagePercentage!
      ? sample
      : current,
    null,
  );
  const maximumUsagePercentage = dominant?.usagePercentage ?? null;
  const action = maximumUsagePercentage === null
    ? 'warning_only'
    : maximumUsagePercentage >= thresholds.rotationPendingPercentage
    ? 'rotation_pending'
    : maximumUsagePercentage >= thresholds.checkpointPreparationPercentage
    ? 'prepare_checkpoint'
    : 'reuse';
  return {
    action,
    maximumUsagePercentage,
    highPriority: maximumUsagePercentage !== null
      && maximumUsagePercentage >= thresholds.highPriorityPercentage,
    dominant,
    samples,
  };
}

export async function evaluateWorkflowRoomRotation(args: {
  room: {
    sourceTask: { id: string; name: string } | null;
    members: Array<{
      id: string;
      memberType: string;
      displayName: string;
      userNickname: string | null;
      backend: string | null;
      harnessType: string | null;
      gatewayId: string | null;
      roleLabel: string | null;
      role: string;
      runtimeAgentId: string | null;
      codexModel: string | null;
      codexReasoningEffort: string | null;
      joinStatus: string;
      presenceStatus: string;
      canReply: boolean;
      gateway: { id: string; name: string } | null;
    }>;
  };
  config: unknown;
}) {
  const thresholds = parseWorkflowRotationThresholds(args.config);
  const relevantMembers = args.room.members.filter((member) =>
    member.memberType !== 'user'
    && member.canReply
    && member.joinStatus === 'joined'
    && ['online', 'busy'].includes(member.presenceStatus));
  const samples = await Promise.all(relevantMembers.map(async (member): Promise<WorkflowRoomWatermark> => {
    const watermark = await getLiveRoomMemberContextWatermark({
      member,
      sourceTask: args.room.sourceTask,
    });
    return {
      memberId: member.id,
      memberName: member.userNickname || member.displayName,
      harnessType: member.harnessType,
      usagePercentage: watermark?.usagePercentage ?? null,
      source: watermark?.source ?? 'unknown',
      label: watermark?.dominantLabel ?? 'context unknown',
    };
  }));
  return {
    thresholds,
    decision: decideWorkflowRoomRotation(samples, thresholds),
  };
}

export const formatWorkflowRotationNotice = (
  decision: WorkflowRotationDecision,
  thresholds: WorkflowRotationThresholds,
) => {
  const unknownSuffix = decision.samples.some((sample) => sample.usagePercentage === null)
    ? ' 部分 Agent 的 provider 水位未知、过期或 Session 不匹配，仅作提示。'
    : '';
  if (decision.maximumUsagePercentage === null) {
    return 'Session 水位：可信 provider 数据未知或已过期；仅告警，本次不自动换代。';
  }
  const dominant = `${decision.dominant?.memberName || 'agent'} ${decision.maximumUsagePercentage}%`;
  if (decision.action === 'rotation_pending') {
    return `${decision.highPriority ? '高优先级：' : ''}Session 水位 ${dominant}，达到 ${thresholds.rotationPendingPercentage}% 换代线。${unknownSuffix}`;
  }
  if (decision.action === 'prepare_checkpoint') {
    return `Session 水位 ${dominant}，达到 ${thresholds.checkpointPreparationPercentage}%：请完成当前工作并准备精简 Handover；本次仍复用原 Session。${unknownSuffix}`;
  }
  return `Session 水位 ${dominant}，低于 ${thresholds.checkpointPreparationPercentage}%：rotation_not_required，复用原 Session。${unknownSuffix}`;
};
