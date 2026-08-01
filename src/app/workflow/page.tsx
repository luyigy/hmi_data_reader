import { loadWorkflowStatuses } from '@/lib/scheduled-jobs/workflow-status';

export const dynamic = 'force-dynamic';

const tone = (stage: string) => {
  if (['文档错误', '运行故障', '运行阻塞'].includes(stage)) return 'border-red-200 bg-red-50 text-red-900';
  if (['已隔离', '等待审批', '等待修改意见', '等待修改提交', '等待手动推进'].includes(stage)) {
    return 'border-amber-200 bg-amber-50 text-amber-900';
  }
  if (stage === '正在执行') return 'border-blue-200 bg-blue-50 text-blue-900';
  return 'border-emerald-200 bg-emerald-50 text-emerald-900';
};

export default async function WorkflowPage() {
  const statuses = await loadWorkflowStatuses();
  return (
    <div>
      <header className="mb-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
          Read-only projection
        </div>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">Workflow Status</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
          状态来自 watcher cursor、ScheduledJob、审批、dispatch 与 TaskSession；本页不会推进游标或启动 Session。
        </p>
      </header>

      <div className="grid gap-6">
        {statuses.map((status) => (
          <article key={`${status.projectId}:${status.jobId}`} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">{status.projectName}</h2>
                <p className="mt-1 text-sm text-slate-500">{status.projectId} / {status.jobId}</p>
              </div>
              <span className={`rounded-full border px-3 py-1 text-sm font-medium ${tone(status.stage)}`}>
                {status.stage}
              </span>
            </div>

            <dl className="mt-6 grid gap-4 text-sm md:grid-cols-2">
              <div><dt className="text-slate-500">ref / HEAD</dt><dd className="mt-1 break-all font-mono text-slate-900">{status.ref} / {status.head}</dd></div>
              <div><dt className="text-slate-500">自治模式</dt><dd className="mt-1 text-slate-900">{status.autonomy}（{status.autonomySource}）</dd></div>
              <div><dt className="text-slate-500">PLAN / Slice / 动作</dt><dd className="mt-1 text-slate-900">{status.plan} / {status.slice} / {status.action}</dd></div>
              <div><dt className="text-slate-500">审批</dt><dd className="mt-1 text-slate-900">{status.approval}</dd></div>
              <div><dt className="text-slate-500">Session</dt><dd className="mt-1 break-all text-slate-900">{status.session}</dd></div>
              <div><dt className="text-slate-500">Validator</dt><dd className="mt-1 text-slate-900">{status.validator}</dd></div>
              <div><dt className="text-slate-500">重试 / 隔离</dt><dd className="mt-1 text-slate-900">{status.retry}</dd></div>
              <div><dt className="text-slate-500">最近成功</dt><dd className="mt-1 text-slate-900">{status.lastSuccessAt}</dd></div>
              <div><dt className="text-slate-500">最近错误</dt><dd className="mt-1 text-slate-900">{status.lastError}</dd></div>
            </dl>

            {status.completion ? (
              <section className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <h3 className="font-semibold">完成回执</h3>
                <p className="mt-2 break-all">commit：{status.completion.commit}</p>
                <p className="mt-1">实际验证：{status.completion.validation}</p>
                <p className="mt-1">HANDOVER / 验收入口：{status.completion.entry}</p>
                <p className="mt-1">自动推进：{status.completion.automaticProgression}</p>
              </section>
            ) : null}

            {status.overview ? (
              <section className="mt-6 rounded-2xl border border-slate-200 p-4 text-sm text-slate-900">
                <h3 className="font-semibold">全部当前计划与排队序列</h3>
                <p className="mt-2 text-slate-600">
                  当前计划 {status.overview.plans.length} 个；排队 {status.overview.queue.length} 个
                </p>
                <ol className="mt-3 space-y-1">
                  {status.overview.queue.length
                    ? status.overview.queue.map((plan) => (
                      <li key={plan.path}>{plan.queuePosition}. {plan.number} {plan.title} · {plan.state}</li>
                    ))
                    : <li>无</li>}
                </ol>
                <div className="mt-5 space-y-4">
                  {status.overview.plans.map((plan) => (
                    <div key={plan.path}>
                      <p className="font-medium">{plan.number} {plan.title} · {plan.state}</p>
                      <ul className="mt-1 ml-5 list-disc text-slate-600">
                        {plan.slices.length
                          ? plan.slices.map((slice) => (
                            <li key={slice.id}>{slice.id} {slice.state} · {slice.title}</li>
                          ))
                          : <li>无可识别的 Slice</li>}
                      </ul>
                    </div>
                  ))}
                </div>
                {status.overview.warnings.length ? (
                  <div className="mt-5 rounded-xl bg-amber-50 p-3 text-amber-900">
                    {status.overview.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
                  </div>
                ) : null}
              </section>
            ) : null}

            <div className="mt-6 rounded-2xl bg-slate-900 p-4 text-sm text-white">
              <span className="font-semibold">唯一下一步：</span>{status.nextStep}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
