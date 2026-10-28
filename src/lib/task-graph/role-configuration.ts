import { prisma } from '../prisma';
import { listLiveRoomCatalogAgents } from '../live-room';
import type { AcpxParticipantRequest } from '../acpx/types';
import type { GraphDefinition } from './domain';

export type RoleOption = { value: string; label: string; role: string; participant: AcpxParticipantRequest };

type RoomRoleMember = { joinStatus: string; backend: string | null; gatewayId: string | null;
  harnessType: string | null; role: string; displayName: string; userNickname?: string | null; codexModel?: string | null; codexReasoningEffort?: string | null };

function matchingRoomMember(agent: { backend: string; gatewayId: string; harnessType: string }, members: RoomRoleMember[]) {
  return members.find((item) => item.joinStatus === 'joined' && item.backend === agent.backend &&
    item.harnessType === agent.harnessType && (!item.gatewayId || item.gatewayId === agent.gatewayId));
}

export function roomRoleCandidates<T extends { backend: string; gatewayId: string; harnessType: string }>(
  candidates: T[], members: RoomRoleMember[],
): T[] {
  const joined = candidates.filter((agent) => matchingRoomMember(agent, members));
  return joined.length ? joined : candidates;
}

export async function graphRoleOptions(parentTaskId: string): Promise<RoleOption[]> {
  const [catalog, room] = await Promise.all([
    listLiveRoomCatalogAgents(),
    prisma.liveRoom.findFirst({ where: { sourceTaskId: parentTaskId }, include: { members: true } }),
  ]);
  const candidates = catalog.filter((agent) => agent.backend === 'platform_local' && ['codex', 'kimi-code'].includes(agent.harnessType));
  return roomRoleCandidates(candidates, room?.members || []).map((agent) => {
    const member = matchingRoomMember(agent, room?.members || []);
    return { value: agent.id, label: member?.userNickname || member?.displayName || agent.label,
      role: member?.role || 'custom', participant: { gatewayId: agent.gatewayId,
        ...(agent.gatewayName ? { gatewayName: agent.gatewayName } : {}),
        executionBackend: 'platform_local', harnessType: agent.harnessType,
        ...(member?.codexModel ? { model: member.codexModel } : {}),
        ...(member?.codexReasoningEffort ? { reasoningEffort: member.codexReasoningEffort } : {}),
        ...(agent.runtimeAgentId ? { agentId: agent.runtimeAgentId } : {}),
        ...(agent.agentName ? { agentName: agent.agentName } : {}), role: 'implementer' } };
  });
}

export function configureGraphRoles(args: {
  definition: GraphDefinition; options: RoleOption[]; form: Record<string, unknown>;
  suggest: boolean; humanId: string; preserveExplicitRoles?: boolean;
}): GraphDefinition {
  const graph = structuredClone(args.definition);
  if (graph.adoptRun) return graph;
  const agentOwned = ['agent_owned_v1', 'agent_commit_v1'].includes(graph.deliveryContract || '');
  // Only proposal configuration supplies defaults; approved run snapshots are never normalized.
  if (agentOwned) for (const node of graph.nodes) {
    if (!node.executionMode && !node.architectureReview && !graph.defaultArchitectureReview) node.executionMode = 'lean';
  }
  const selected = (name: string) => typeof args.form[name] === 'string' ? args.form[name] : undefined;
  const participant = (selector: string, role: string) => {
    const option = args.options.find((item) => item.value === selector);
    if (!option) throw new Error(`Agent 已不可用：${selector}`);
    return { ...option.participant, role };
  };
  const suggested = (role: string) => args.options.find((item) => item.role === role)?.value;
  const recommendation = (role: string, configured: boolean) => {
    const preserve = args.preserveExplicitRoles || (agentOwned && role === 'reviewer');
    return args.suggest && (!preserve || !configured) ? suggested(role) : undefined;
  };
  const hadProjectArchitect = !!graph.defaultArchitectureReview;
  const needsProjectArchitect = graph.nodes.some((node) => !node.executionMode || node.executionMode === 'full');
  const projectArchitect = recommendation('reviewer', hadProjectArchitect || !needsProjectArchitect) || selected('architecture_default');
  if (projectArchitect === 'none') delete graph.defaultArchitectureReview;
  else if (projectArchitect) graph.defaultArchitectureReview = { reviewerId: projectArchitect,
    reviewLaunchConfig: { participant: participant(projectArchitect, 'reviewer') } };
  graph.nodes.forEach((node, i) => {
    const mode = selected(`mode_${i}`);
    if (mode !== undefined) {
      if (mode !== 'full' && mode !== 'lean' && mode !== 'implement') throw new Error('执行模式无效');
      node.executionMode = mode;
    }
    node.executions.forEach((job, j) => {
      const selector = recommendation('implementer', !!job.agentSelector) || selected(`job_${i}_${j}`);
      if (selector) {
        const current = job.launchConfig && typeof job.launchConfig === 'object' ? job.launchConfig : {};
        job.launchConfig = { ...current, participant: participant(selector, 'implementer') };
        job.agentSelector = selector;
      }
    });
    const needsArchitecture = !node.executionMode || node.executionMode === 'full';
    const hasArchitecture = !!node.architectureReview || hadProjectArchitect;
    const architecture = recommendation('reviewer', !needsArchitecture || hasArchitecture) || selected(`architecture_${i}`);
    if (architecture && architecture !== 'inherit') node.architectureReview = {
      reviewerId: architecture, reviewLaunchConfig: { participant: participant(architecture, 'reviewer') },
    };
    if (architecture === 'inherit') delete node.architectureReview;
    const acceptanceConfigured = node.acceptance.mode === 'automatic' || !!node.acceptance.reviewerId;
    // A room Tester is an available option, not consent to independent acceptance.
    const acceptance = agentOwned ? selected(`acceptance_${i}`)
      : recommendation('tester', acceptanceConfigured) || selected(`acceptance_${i}`);
    if (acceptance) {
      const checks = { ...node.acceptance };
      delete checks.reviewerId;
      delete checks.reviewLaunchConfig;
      node.acceptance = acceptance === 'automatic' ? { ...checks, mode: 'automatic' }
        : acceptance === 'human' ? { ...checks, mode: 'human', reviewerId: args.humanId }
        : { ...checks, mode: 'agent', reviewerId: acceptance,
          reviewLaunchConfig: { participant: participant(acceptance, 'tester') } };
    }
  });
  return graph;
}
