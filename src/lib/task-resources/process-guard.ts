import { prisma } from '../prisma';
import { requestRunControl } from '../acpx/process-registry';
import { getResourceApproval } from './access';
import { verifyResourceDirectories } from './model';

export async function assertResourceUseActive(taskRunId: string, approvalIds: string[]) {
  if (!approvalIds.length) return;
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId }, select: { controlState: true } });
  if (run.controlState === 'stop_requested') throw new Error('资源运行已请求停止');
  for (const id of approvalIds) {
    const approval = await getResourceApproval(id);
    if (approval.status !== 'approved') throw new Error('资源授权已撤销，禁止继续执行');
    await verifyResourceDirectories(approval.payload.resources);
  }
}

export async function withResourceProcessGuard<T>(taskRunId: string, participantId: string, approvalIds: string[], execute: () => Promise<T>): Promise<T> {
  if (!approvalIds.length) return execute();
  await assertResourceUseActive(taskRunId, approvalIds);
  let check: Promise<void> | undefined;
  let failure: Error | undefined;
  const timer = setInterval(() => {
    if (check) return;
    check = assertResourceUseActive(taskRunId, approvalIds).catch(error => {
      failure = error instanceof Error ? error : new Error(String(error));
      requestRunControl(taskRunId, participantId, 'stop_run');
    }).finally(() => { check = undefined; });
  }, 250);
  timer.unref();
  try {
    const result = await execute();
    await check;
    if (failure) throw failure;
    await assertResourceUseActive(taskRunId, approvalIds);
    return result;
  } finally {
    clearInterval(timer);
    await check;
  }
}
