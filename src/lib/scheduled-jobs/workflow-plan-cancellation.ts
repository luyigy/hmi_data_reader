import type { ProjectConfig } from './project-config';
import type { WorkflowStatus } from './workflow-status';
import { prisma } from '../prisma';
import { buildWorkflowSkipCursor } from './workflow-inspection';
import { completeWorkflowPlan } from './workflow-plan-completion';

export async function cancelWorkflowPlan(args: {
  project: ProjectConfig;
  job: ProjectConfig['jobs'][number];
  workflowStatus?: WorkflowStatus;
  selectedPlan?: string;
  expectedHead?: string;
}) {
  if (!args.expectedHead || !args.workflowStatus || args.workflowStatus.head !== args.expectedHead) {
    return 'Dashboard 已失效，请刷新后重新选择 PLAN。';
  }
  if (args.workflowStatus.running) return '当前 Workflow 正在运行，不能取消 PLAN；请先停止当前运行。';
  if (!args.selectedPlan
    || !args.workflowStatus.overview?.plans.some(({ path }) => path === args.selectedPlan)) {
    return '所选 PLAN 已结束或不在当前未完成清单，请刷新后重选。';
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${args.project.id}:${args.job.id}`}, 0))::text`;
    if (await tx.scheduledJobRun.count({
      where: { projectId: args.project.id, jobId: args.job.id, status: 'running' },
    })) throw new Error(`${args.job.id} 正在运行，请先停止当前运行`);
    const state = await tx.scheduledJobState.findUnique({
      where: { projectId_jobId: { projectId: args.project.id, jobId: args.job.id } },
      select: { cursorJson: true },
    });
    const cursor = state?.cursorJson;
    const pending = cursor && typeof cursor === 'object' && !Array.isArray(cursor)
      ? (cursor as { pending?: { key?: unknown; path?: unknown } }).pending : undefined;
    if (pending && pending.path !== args.selectedPlan) {
      throw new Error(`当前 pending 属于 ${String(pending.path)}，不能取消其他 PLAN`);
    }
    const completion = await completeWorkflowPlan({
      project: args.project,
      planPath: args.selectedPlan!,
      contractPath: String(args.job.config.contract_path || ''),
      expectedHead: args.expectedHead!,
      disposition: 'cancel',
    });
    if (completion.state === 'stale') return completion;
    if (pending) {
      const skipped = buildWorkflowSkipCursor(cursor, args.selectedPlan!);
      if (!skipped) throw new Error('pending 已变化，请刷新 Dashboard 后重试');
      await tx.scheduledJobState.update({
        where: { projectId_jobId: { projectId: args.project.id, jobId: args.job.id } },
        data: { cursorJson: { ...skipped, commit: completion.head } },
      });
    }
    return completion;
  }, { timeout: 30_000 }).then((completion) => completion.state === 'stale'
    ? `Dashboard 已失效：当前 HEAD ${completion.head}，请刷新后重选。`
    : `✅ 已取消实施 PLAN 并提交：${completion.path}\n新 HEAD：${completion.head}`)
    .catch((error) => `❌ 取消 PLAN 失败：${error instanceof Error ? error.message : String(error)}`);
}
