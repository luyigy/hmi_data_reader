import { prisma } from '../prisma';

export async function resourceTaskBinding(taskId: string) {
  const own = await prisma.feishuConversationBinding.findFirst({ where: { liveRoom: { sourceTaskId: taskId } }, orderBy: { updatedAt: 'desc' } });
  if (own) return own;
  const execution = await prisma.taskGraphExecution.findUnique({ where: { childTaskId: taskId }, select: { node: { select: { run: { select: { parentTaskId: true } } } } } });
  const review = /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId);
  const parentTaskId = execution?.node.run.parentTaskId || (review && await prisma.taskGraphNode.findUnique({ where: { id: review[1] }, select: { run: { select: { parentTaskId: true } } } }))?.run.parentTaskId;
  return parentTaskId ? prisma.feishuConversationBinding.findFirst({ where: { liveRoom: { sourceTaskId: parentTaskId } }, orderBy: { updatedAt: 'desc' } }) : null;
}
