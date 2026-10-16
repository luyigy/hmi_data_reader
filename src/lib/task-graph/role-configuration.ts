import { prisma } from '../prisma';
import { listLiveRoomCatalogAgents } from '../live-room';
import type { AcpxParticipantRequest } from '../acpx/types';
import type { GraphDefinition } from './domain';

export type RoleOption = { value: string; label: string; role: string; participant: AcpxParticipantRequest };

export async function graphRoleOptions(parentTaskId: string): Promise<RoleOption[]> {
  const [catalog, room] = await Promise.all([
    listLiveRoomCatalogAgents(),
    prisma.liveRoom.findFirst({ where: { sourceTaskId: parentTaskId }, include: { members: true } }),
  ]);
  return catalog.filter((agent) => agent.backend === 'platform_local' && agent.harnessType).map((agent) => {
    const member = room?.members.find((item) => item.joinStatus === 'joined' &&
      item.backend === agent.backend && item.gatewayId === agent.gatewayId && item.harnessType === agent.harnessType);
    return { value: agent.id, label: member?.userNickname || member?.displayName || agent.label,
      role: member?.role || 'custom', participant: { gatewayId: agent.gatewayId,
        ...(agent.gatewayName ? { gatewayName: agent.gatewayName } : {}),
        executionBackend: 'platform_local', harnessType: agent.harnessType,
        ...(agent.runtimeAgentId ? { agentId: agent.runtimeAgentId } : {}),
        ...(agent.agentName ? { agentName: agent.agentName } : {}), role: 'implementer' } };
  });
}

export function configureGraphRoles(args: {
  definition: GraphDefinition; options: RoleOption[]; form: Record<string, unknown>;
  suggest: boolean; humanId: string;
}): GraphDefinition {
  const graph = structuredClone(args.definition);
  const selected = (name: string) => typeof args.form[name] === 'string' ? args.form[name] : undefined;
  const participant = (selector: string, role: string) => {
    const option = args.options.find((item) => item.value === selector);
    if (!option) throw new Error(`Agent 已不可用：${selector}`);
    return { ...option.participant, role };
  };
  const suggested = (role: string) => args.options.find((item) => item.role === role)?.value;
  const projectArchitect = (args.suggest ? suggested('reviewer') : undefined) || selected('architecture_default');
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
      const selector = (args.suggest ? suggested('implementer') : undefined) || selected(`job_${i}_${j}`);
      if (selector) {
        const current = job.launchConfig && typeof job.launchConfig === 'object' ? job.launchConfig : {};
        job.launchConfig = { ...current, participant: participant(selector, 'implementer') };
        job.agentSelector = selector;
      }
    });
    const architecture = (args.suggest ? suggested('reviewer') : undefined) || selected(`architecture_${i}`);
    if (architecture && architecture !== 'inherit') node.architectureReview = {
      reviewerId: architecture, reviewLaunchConfig: { participant: participant(architecture, 'reviewer') },
    };
    if (architecture === 'inherit') delete node.architectureReview;
    const acceptance = (args.suggest ? suggested('tester') : undefined) || selected(`acceptance_${i}`);
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
