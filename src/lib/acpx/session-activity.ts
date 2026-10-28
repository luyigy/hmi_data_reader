import type { Prisma } from '@prisma/client';
export const activeRunStatuses = ['pending', 'running', 'waiting_for_input'];

export async function lockSessionActivity(tx: Prisma.TransactionClient, taskId: string, sessionId: string) {
  await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "TaskSession" WHERE id = ${sessionId} FOR UPDATE`;
}

/** TaskRun is the fact source. A singleton pointer is only meaningful with exactly one active run. */
export async function refreshSessionActivity(tx: Prisma.TransactionClient, taskId: string, sessionId: string) {
  const runs = await tx.taskRun.findMany({ where: { taskSessionId: sessionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, summary: true, error: true, completedAt: true } });
  const active = runs.filter(run => activeRunStatuses.includes(run.status));
  const waiting = active.some(run => run.status === 'waiting_for_input');
  const latest = runs[0];
  const failed = latest && latest.status !== 'completed';
  await tx.taskSession.update({ where: { id: sessionId }, data: {
    activeRunId: active.length === 1 ? active[0].id : null,
    status: active.length ? (active.every(run => run.status === 'waiting_for_input') ? 'waiting_user' : 'active') : !failed ? 'active' : 'failed',
    attentionState: waiting ? 'needs_user_input' : active.length || !failed ? 'normal' : ['interrupted', 'stopped'].includes(latest.status) ? 'needs_review' : 'error',
    ...(active.length ? {} : { summary: latest?.summary }),
  } });
  const anyActive = await tx.taskRun.count({ where: { taskId, status: { in: activeRunStatuses } } });
  if (anyActive) await tx.task.update({ where: { id: taskId }, data: { status: 'running', completedAt: null, error: null } });
}
