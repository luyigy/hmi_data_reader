import { prisma } from '../prisma';

/** Legacy role task IDs identify a node only when that node exists in the ledger. */
export async function graphNodeForTask(taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const execution = await prisma.taskGraphExecution.findUnique({ where: { childTaskId: taskId }, select: { nodeId: true } });
  if (execution) return execution.nodeId;
  const reviewNodeId = /^task-graph-(?:review|architecture)-(.+)$/.exec(taskId)?.[1];
  if (reviewNodeId) return (await prisma.taskGraphNode.findUnique({ where: { id: reviewNodeId }, select: { id: true } }))?.id || null;
  const discussionExecutionId = /^task-graph-discussion-(.+)$/.exec(taskId)?.[1];
  return discussionExecutionId
    ? (await prisma.taskGraphExecution.findUnique({ where: { id: discussionExecutionId }, select: { nodeId: true } }))?.nodeId || null
    : null;
}
