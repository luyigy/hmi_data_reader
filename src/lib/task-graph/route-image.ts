import { prisma } from '../prisma';
import { uploadFeishuCardImage } from '../feishu-api';
import type { GraphDefinition } from './domain';
import { renderGraphPng } from './route-diagram';

export async function ensureGraphRouteImage(proposalId: string, definition: GraphDefinition) {
  const proposal = await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: proposalId } });
  if (proposal.routeImageKey) return proposal.routeImageKey;
  const imageKey = await uploadFeishuCardImage(Buffer.from(renderGraphPng(definition)));
  await prisma.taskGraphProposal.updateMany({ where: { id: proposalId, routeImageKey: null }, data: { routeImageKey: imageKey } });
  return (await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: proposalId } })).routeImageKey!;
}
