'use client';

import { useTaskChat } from './task-chat-context';

export function TaskChatInspector() {
  const { isInspectorOpen, setIsInspectorOpen, isRunHistoryOpen, setIsRunHistoryOpen,
    runSummaries, selectedRunId, setSelectedRunId, isSelectedSummaryOpen,
    setIsSelectedSummaryOpen, selectedRun, isParticipantOutcomesOpen,
    setIsParticipantOutcomesOpen, handleParticipantConnectivityProbe, participantProbeState } = useTaskChat();
  return (
        <aside className={`${isInspectorOpen ? 'hidden min-h-0 border-l border-slate-200/80 bg-white/75 xl:flex xl:flex-col' : 'hidden'}`}>
          {isInspectorOpen ? (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-2 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <div className="text-sm font-medium text-slate-900">Inspector</div>
                  <div className="mt-1 text-xs text-slate-500">运行历史、摘要和参与方详情</div>
                </div>
                <button
                  onClick={() => setIsInspectorOpen(false)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  收起
                </button>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                <button
                  onClick={() => setIsRunHistoryOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <div className="text-sm font-medium text-slate-900">Run History</div>
                  <span className="text-xs text-slate-500">{isRunHistoryOpen ? '收起' : '展开'}</span>
                </button>
                {isRunHistoryOpen ? (
                  <div className="mt-3 max-h-[30vh] space-y-2 overflow-y-auto pr-1">
                {runSummaries.length === 0 ? (
                  <div className="text-sm text-slate-500">还没有运行历史。</div>
                ) : (
                  runSummaries.map((run, index) => (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                        selectedRunId === run.id
                          ? 'border-slate-300 bg-slate-100'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900">Run {runSummaries.length - index}</div>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${
                          run.status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : run.status === 'interrupted'
                            ? 'bg-amber-100 text-amber-800'
                            : run.status === 'stopped'
                            ? 'bg-orange-100 text-orange-800'
                            : run.status === 'failed'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}>
                          {run.status}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false })}
                      </div>
                      {run.activityState || run.controlState ? (
                        <div className="mt-1 text-[11px] text-slate-500">
                          {run.activityState ? `activity=${run.activityState}` : ''}
                          {run.activityState && run.controlState ? ' · ' : ''}
                          {run.controlState ? `control=${run.controlState}` : ''}
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {run.participants.map((participant) => (
                          <span
                            key={participant.id}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                          >
                            {participant.role} / {participant.harnessType}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))
                )}
                  </div>
                ) : null}
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                <button
                  onClick={() => setIsSelectedSummaryOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <div className="text-sm font-medium text-slate-900">Selected Run Summary</div>
                  <span className="text-xs text-slate-500">{isSelectedSummaryOpen ? '收起' : '展开'}</span>
                </button>
                {isSelectedSummaryOpen ? (
                  <div className="mt-3 whitespace-pre-wrap text-sm text-slate-600">
                    {selectedRun?.summary || selectedRun?.error || '暂无运行摘要'}
                  </div>
                ) : null}
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                <button
                  onClick={() => setIsParticipantOutcomesOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <div className="text-sm font-medium text-slate-900">Participant Outcomes</div>
                  <span className="text-xs text-slate-500">{isParticipantOutcomesOpen ? '收起' : '展开'}</span>
                </button>
                {isParticipantOutcomesOpen ? (
                  <div className="mt-3 space-y-3">
                {(selectedRun?.participants || []).map((participant) => (
                  <div key={participant.id} className="rounded-2xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {participant.role} · {participant.executionBackend === 'platform_local' ? 'Platform Local' : participant.gatewayName} / {participant.harnessType}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        participant.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : participant.status === 'interrupted'
                          ? 'bg-amber-100 text-amber-800'
                          : participant.status === 'stopped'
                          ? 'bg-orange-100 text-orange-800'
                          : participant.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {participant.status}
                      </span>
                    </div>
                    {participant.activityState ? (
                      <div className="mt-2 text-xs text-slate-500">
                        activity: {participant.activityState}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-slate-500">
                      {participant.interruptSupported ? <span className="rounded-full bg-slate-100 px-2 py-0.5">可中断</span> : null}
                      {participant.softStopSupported ? <span className="rounded-full bg-slate-100 px-2 py-0.5">可停止</span> : null}
                      {participant.resumeSupported ? <span className="rounded-full bg-slate-100 px-2 py-0.5">可恢复重启</span> : null}
                    </div>
                    {participant.executionBackend === 'gateway_openclaw' ? (
                      <div className="mt-3 space-y-2">
                        <button
                          onClick={() => void handleParticipantConnectivityProbe(participant)}
                          disabled={participantProbeState[participant.id]?.status === 'testing'}
                          className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          {participantProbeState[participant.id]?.status === 'testing'
                            ? '测试中...'
                            : '测试远端连通性'}
                        </button>
                        {participantProbeState[participant.id]?.message ? (
                          <div className={`rounded-lg px-3 py-2 text-xs ${
                            participantProbeState[participant.id]?.status === 'error'
                              ? 'border border-red-200 bg-red-50 text-red-700'
                              : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                          }`}>
                            {participantProbeState[participant.id]?.message}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-3 text-xs text-slate-500">
                        本地 direct harness 的独立连通性测试还未做成单独入口。
                      </div>
                    )}
                    {participant.summary ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{participant.summary}</p>
                    ) : null}
                    {participant.error ? (
                      <p className="mt-2 text-sm text-red-600">{participant.error}</p>
                    ) : null}
                    {participant.filesModified.length > 0 ? (
                      <div className="mt-2 text-xs text-slate-500">
                        修改文件: {participant.filesModified.join(', ')}
                      </div>
                    ) : null}
                  </div>
                ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </aside>

  );
}
