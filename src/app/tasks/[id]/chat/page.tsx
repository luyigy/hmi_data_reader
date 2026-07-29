'use client';

import { WorkflowPermissionSnapshotCard } from '@/components/tasks/WorkflowPermissionSnapshotCard';
import { getPermissionProfileLabel } from '@/lib/acpx/permissions';
import { TaskChatProvider } from './task-chat-context';
import { TaskChatComposer } from './TaskChatComposer';
import { TaskChatInspector } from './TaskChatInspector';
import { TaskChatTimeline } from './TaskChatTimeline';
import { getPermissionSupportLabel, permissionSupportTone } from './task-chat-types';
import { useTaskChatController } from './use-task-chat-controller';

export default function TaskChatPage() {
  const controller = useTaskChatController();
  const { task, taskRoom, isLoading, isConnected, socketUnavailableReason, selectedRun,
    canExecute, handleExecuteTask, isExecuting, activeRunSummary, isPermissionEditorOpen,
    setIsPermissionEditorOpen, isRoomDetailsOpen, setIsRoomDetailsOpen, isInspectorOpen,
    setIsInspectorOpen, latestHarnessRequest, permissionConfig, draftPermissionStatusItems,
    selectedRunWorkflowPermissionSnapshot, selectedRunPermissionConfig,
    selectedRunPermissionStatusItems, selectedRunSessionTrackingLabel,
    selectedRunSessionTracking, remoteQuietHint, selectedRunLabel, controlRunLabel,
    selectedRunIsActive, composerBehaviorHint, latestHarnessRequestIsActionable,
    handleHarnessDecision, isSending, controlRunCanInterrupt, handleGrantAgentRights,
    isSavingPermissionConfig } = controller;

  if (isLoading) {
    return <div className="p-8 text-gray-600">加载中...</div>;
  }

  if (!task) {
    return <div className="p-8 text-gray-600">任务不存在</div>;
  }

  return (
    <TaskChatProvider value={controller}>
    <div className="mx-auto flex h-[calc(100vh-0.5rem)] max-w-[1680px] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-[#f7f7f8] shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <header className="shrink-0 border-b border-slate-200/80 bg-white/92 px-4 py-3 backdrop-blur xl:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
              <span>{task.executionMode === 'acpx' ? 'ACPX Task Room' : 'Task Chat'}</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{taskRoom?.name || 'Task Room'}</span>
            </div>
            <h1 className="mt-1 truncate text-lg font-semibold text-slate-900 xl:text-xl">{task.name}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-[11px] font-medium ${
              isConnected
                ? 'bg-emerald-100 text-emerald-800'
                : socketUnavailableReason
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-600'
            }`}>
              {isConnected ? '实时连接中' : socketUnavailableReason ? '轮询刷新中' : '等待刷新'}
            </span>
            {selectedRun?.status ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-700">
                run {selectedRun.status}
              </span>
            ) : null}
            {selectedRun?.activityState ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-700">
                activity {selectedRun.activityState}
              </span>
            ) : null}
            {canExecute ? (
              <button
                onClick={() => void handleExecuteTask()}
                disabled={isExecuting}
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isExecuting ? '执行中...' : '启动新 Run'}
              </button>
            ) : (
              <span className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-700">
                {activeRunSummary ? '当前 active run 进行中' : '当前不可启动新 run'}
              </span>
            )}
            {task.executionMode === 'acpx' ? (
              <button
                onClick={() => setIsPermissionEditorOpen((prev) => !prev)}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                {isPermissionEditorOpen ? '收起权限设置' : '权限设置'}
              </button>
            ) : null}
            {task.executionMode === 'acpx' ? (
              <button
                onClick={() => setIsRoomDetailsOpen((prev) => !prev)}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                {isRoomDetailsOpen ? '隐藏详情' : '房间详情'}
              </button>
            ) : null}
            <button
              onClick={() => setIsInspectorOpen((prev) => !prev)}
              className="hidden rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 xl:inline-flex"
            >
              {isInspectorOpen ? '隐藏侧栏' : '显示侧栏'}
            </button>
          </div>
        </div>

      </header>

      <div
        className={`grid min-h-0 flex-1 overflow-hidden ${
          isInspectorOpen
            ? 'xl:grid-cols-[minmax(0,1fr),320px]'
            : 'xl:grid-cols-[minmax(0,1fr)]'
        }`}
      >
        <section className="grid min-h-0 grid-rows-[auto,minmax(0,1fr),auto] overflow-hidden bg-[#f7f7f8]">
          <div className="shrink-0 border-b border-slate-200/70 bg-[#f7f7f8] px-4 py-3 xl:px-6">
            <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
              <span className="font-medium text-slate-700">对话</span>
              {latestHarnessRequest || isRoomDetailsOpen ? (
                <span className="text-[11px] text-slate-400">
                  {latestHarnessRequest ? 'agent 需要处理' : '详情已展开'}
                </span>
              ) : null}
            </div>

            {isRoomDetailsOpen ? (
              <div className="mt-3 rounded-[22px] border border-slate-200 bg-white/90 p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  {task.executionMode === 'acpx' ? (
                    <span className="rounded-full border border-slate-200 bg-slate-50/70 px-2.5 py-1">
                      聊天优先布局已启用
                    </span>
                  ) : null}
                  {task.executionMode === 'acpx' ? (
                    <>
                      <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                        Profile: {getPermissionProfileLabel(permissionConfig.profile)}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                        Sandbox: {permissionConfig.sandboxMode}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                        Network: {permissionConfig.networkAccess}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500">
                        Approval: {permissionConfig.approvalPolicy}
                      </span>
                      {draftPermissionStatusItems.map((item) => (
                        <span
                          key={item.key}
                          className={`rounded-full px-2.5 py-1 ring-1 ${permissionSupportTone[item.state]}`}
                        >
                          {item.label}: {getPermissionSupportLabel(item.state)}
                        </span>
                      ))}
                    </>
                  ) : null}
                  {task.executionMode === 'acpx' && task.acpxParticipants?.length
                    ? task.acpxParticipants.map((participant, index) => (
                        <span
                          key={`${participant.gatewayId}-${participant.harnessType}-${index}`}
                          className="rounded-full border border-slate-200 bg-white/85 px-2.5 py-1 text-slate-500"
                        >
                          {participant.role} · {participant.executionBackend === 'platform_local' ? 'Local' : (participant.gatewayName || participant.gatewayId)} / {participant.harnessType}
                        </span>
                      ))
                    : null}
                  {socketUnavailableReason ? (
                    <span className="rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-amber-700">
                      socket unavailable: {socketUnavailableReason}
                    </span>
                  ) : null}
                  {selectedRun?.controlState ? (
                    <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                      control {selectedRun.controlState}
                    </span>
                  ) : null}
                  {selectedRunWorkflowPermissionSnapshot ? (
                    <WorkflowPermissionSnapshotCard snapshot={selectedRunWorkflowPermissionSnapshot} />
                  ) : selectedRunPermissionConfig ? (
                    <>
                      <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                        run sandbox {selectedRunPermissionConfig.sandboxMode}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                        run network {selectedRunPermissionConfig.networkAccess}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                        run approval {selectedRunPermissionConfig.approvalPolicy}
                      </span>
                    </>
                  ) : null}
                  {!selectedRunWorkflowPermissionSnapshot && selectedRunPermissionStatusItems.map((item) => (
                    <span key={item.key} className={`rounded-full px-2.5 py-1 text-[11px] shadow-sm ring-1 ${permissionSupportTone[item.state]}`}>
                      {item.label} {getPermissionSupportLabel(item.state)}
                    </span>
                  ))}
                  {selectedRunSessionTrackingLabel ? (
                    <span className={`rounded-full px-2.5 py-1 text-[11px] shadow-sm ring-1 ${
                      selectedRunSessionTracking?.sameSessionConfirmed === false
                        ? 'bg-rose-50 text-rose-700 ring-rose-200'
                        : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                    }`}>
                      {selectedRunSessionTrackingLabel}
                    </span>
                  ) : null}
                  {remoteQuietHint ? (
                    <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      {remoteQuietHint}
                    </span>
                  ) : null}
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm ring-1 ring-slate-200">
                    {selectedRunLabel}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] shadow-sm ring-1 ${
                    activeRunSummary
                      ? 'bg-sky-50 text-sky-700 ring-sky-200'
                      : 'bg-slate-100 text-slate-500 ring-slate-200'
                  }`}>
                    {controlRunLabel}
                  </span>
                  {selectedRun && !selectedRunIsActive ? (
                    <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      当前浏览的是历史 run；控制按钮不会作用于它
                    </span>
                  ) : null}
                  {selectedRun?.status === 'waiting_for_input' ? (
                    <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      当前在等待用户输入或平台下一步处理
                    </span>
                  ) : null}
                </div>
                {composerBehaviorHint ? (
                  <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-700">
                    {composerBehaviorHint}
                  </div>
                ) : null}
              </div>
            ) : null}

            {latestHarnessRequest ? (
              <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/85 p-3 text-xs text-amber-950 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">最近一次 harness 请求: {latestHarnessRequest.kind}</div>
                  {!latestHarnessRequestIsActionable ? (
                    <span className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      仅提示，不是可批准请求
                    </span>
                  ) : (
                    <span className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
                      按钮会生成后续处理消息，不会原地注入当前 session
                    </span>
                  )}
                </div>
                <div className="mt-2 whitespace-pre-wrap leading-5">{latestHarnessRequest.message}</div>
                {latestHarnessRequest.excerpt ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-white/80 p-3 text-[11px] text-amber-900">
                    {latestHarnessRequest.excerpt}
                  </pre>
                ) : null}
                {latestHarnessRequestIsActionable ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => void handleHarnessDecision('allow')}
                      disabled={isSending || !controlRunCanInterrupt}
                      className="rounded-full bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
                    >
                      同意并转入下一轮
                    </button>
                    <button
                      onClick={() => void handleHarnessDecision('deny')}
                      disabled={isSending || !controlRunCanInterrupt}
                      className="rounded-full bg-rose-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
                    >
                      拒绝并转入下一轮
                    </button>
                    <button
                      onClick={() => void handleHarnessDecision('explain')}
                      disabled={isSending || !controlRunCanInterrupt}
                      className="rounded-full bg-slate-800 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-900 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      先补充说明
                    </button>
                    <button
                      onClick={() => void handleGrantAgentRights('dev_local')}
                      disabled={isSending || isExecuting || isSavingPermissionConfig}
                      className="rounded-full border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800 transition-colors hover:bg-sky-100 disabled:cursor-not-allowed disabled:border-sky-200 disabled:text-sky-400"
                    >
                      授予开发权限并继续
                    </button>
                    <button
                      onClick={() => void handleGrantAgentRights('full_access')}
                      disabled={isSending || isExecuting || isSavingPermissionConfig}
                      className="rounded-full border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:border-violet-200 disabled:text-violet-400"
                    >
                      授予完全权限并继续
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <TaskChatTimeline />
          <TaskChatComposer />
        </section>

        <TaskChatInspector />
      </div>
    </div>
    </TaskChatProvider>
  );
}
