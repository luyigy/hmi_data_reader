'use client';

import { getPermissionProfileLabel } from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import { getPermissionSupportLabel, permissionSupportTone } from './task-chat-types';
import { useTaskChat } from './task-chat-context';

export function TaskChatComposer() {
  const controller = useTaskChat();
  const { task, conversationMode, setConversationMode, messageTargetType, setMessageTargetType,
    messageTargetParticipantKey, setMessageTargetParticipantKey, taskRoomTargetOptions,
    selectedTargetLabel, handleGrantAgentRights, isSending, isExecuting, isSavingPermissionConfig,
    targetDeliveryHint, isPermissionEditorOpen, setIsPermissionEditorOpen, permissionConfig,
    setPermissionConfig, handlePermissionProfileChange, draftPermissionSupport,
    draftPermissionStatusItems, permissionConfigNotice, selectedRun, handlePermissionConfigSave,
    handleExecuteTask, messageInput, setMessageInput, activeRunSummary, canContinueSelectedSession,
    handleAcpxControl, taskRoom, controlRunCanInterrupt, controlRunCanStop, canExecute,
    handlePrimaryAcpxSend, primarySendLabel, controlError, composerNotice, handleSendMessage } = controller;
  if (!task) return null;
  return (
          <div className="z-10 border-t border-slate-200 bg-white/95 px-3 py-2.5 backdrop-blur xl:px-6">
            {task.executionMode === 'acpx' ? (
              <div className="mx-auto max-w-4xl space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="inline-flex rounded-full border border-slate-200 bg-slate-100 p-0.5">
                    <button
                      onClick={() => setConversationMode('chat')}
                      className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                        conversationMode === 'chat'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      聊天模式
                    </button>
                    <button
                      onClick={() => setConversationMode('run')}
                      className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                        conversationMode === 'run'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      执行模式
                    </button>
                  </div>
                  <select
                    value={messageTargetType}
                    onChange={(event) => setMessageTargetType(event.target.value as 'task' | 'participant' | 'all')}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-transparent focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="task">写入整个任务上下文</option>
                    <option value="participant">给某参与方留消息</option>
                    <option value="all">给全部参与方留消息</option>
                  </select>
                  {messageTargetType === 'participant' ? (
                    <select
                      value={messageTargetParticipantKey}
                      onChange={(event) => setMessageTargetParticipantKey(event.target.value)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-transparent focus:ring-2 focus:ring-slate-400"
                    >
                      {taskRoomTargetOptions
                        .filter((option) => option.type === 'participant')
                        .map((option) => (
                          <option key={option.participantKey} value={option.participantKey || ''}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-500">
                      当前目标：{selectedTargetLabel}
                    </div>
                  )}
                  <button
                    onClick={() => void handleGrantAgentRights('dev_local')}
                    disabled={isSending || isExecuting || isSavingPermissionConfig}
                    className="rounded-full border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 transition-colors hover:bg-sky-100 disabled:cursor-not-allowed disabled:border-sky-200 disabled:text-sky-400"
                  >
                    给 agent 开发权限
                  </button>
                  <button
                    onClick={() => void handleGrantAgentRights('full_access')}
                    disabled={isSending || isExecuting || isSavingPermissionConfig}
                    className="rounded-full border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:border-violet-200 disabled:text-violet-400"
                  >
                    给 agent 完全权限
                  </button>
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-5 text-amber-800">
                    {targetDeliveryHint}
                </div>

                {isPermissionEditorOpen ? (
                  <div className="max-h-[48vh] overflow-y-auto rounded-[24px] border border-slate-200 bg-slate-50/95 p-4 shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-slate-900">Local Harness 权限设置</div>
                        <div className="mt-1 text-[11px] leading-5 text-slate-500">
                          这组设置只会影响下一次新 run 或 continuation，不会热切换当前正在执行的 session。
                        </div>
                      </div>
                      <button
                        onClick={() => setIsPermissionEditorOpen(false)}
                        className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-100"
                      >
                        收起
                      </button>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600">
                      <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                        {getPermissionProfileLabel(permissionConfig.profile)}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                        Sandbox: {permissionConfig.sandboxMode}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                        Network: {permissionConfig.networkAccess}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                        Approval: {permissionConfig.approvalPolicy}
                      </span>
                      {permissionConfig.writableRoots.length > 0 ? (
                        <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                          writable roots: {permissionConfig.writableRoots.length}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {(['safe_local', 'dev_local', 'full_access'] as const).map((profile) => (
                        <button
                          key={profile}
                          onClick={() => handlePermissionProfileChange(profile)}
                          className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                            permissionConfig.profile === profile
                              ? 'bg-slate-900 text-white'
                              : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {getPermissionProfileLabel(profile)}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <label className="space-y-1">
                        <div className="text-[11px] font-medium text-slate-600">Sandbox</div>
                        <select
                          value={permissionConfig.sandboxMode}
                          onChange={(event) =>
                            setPermissionConfig((prev) => ({
                              ...prev,
                              profile: 'custom',
                              sandboxMode: event.target.value as AcpxPermissionConfig['sandboxMode'],
                            }))
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="read-only">read-only</option>
                          <option value="workspace-write">workspace-write</option>
                          <option value="danger-full-access">danger-full-access</option>
                        </select>
                      </label>

                      <label className="space-y-1">
                        <div className="text-[11px] font-medium text-slate-600">Network</div>
                        <select
                          value={permissionConfig.networkAccess}
                          onChange={(event) =>
                            setPermissionConfig((prev) => ({
                              ...prev,
                              profile: 'custom',
                              networkAccess: event.target.value as AcpxPermissionConfig['networkAccess'],
                            }))
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="restricted">restricted</option>
                          <option value="enabled">enabled</option>
                        </select>
                      </label>

                      <label className="space-y-1">
                        <div className="text-[11px] font-medium text-slate-600">Approval</div>
                        <select
                          value={permissionConfig.approvalPolicy}
                          onChange={(event) =>
                            setPermissionConfig((prev) => ({
                              ...prev,
                              profile: 'custom',
                              approvalPolicy: event.target.value as AcpxPermissionConfig['approvalPolicy'],
                            }))
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="never">never</option>
                          <option value="on-request">on-request</option>
                        </select>
                      </label>
                    </div>

                    <label className="mt-3 block space-y-1">
                      <div className="text-[11px] font-medium text-slate-600">Writable Roots</div>
                      <textarea
                        value={permissionConfig.writableRoots.join('\n')}
                        onChange={(event) =>
                          setPermissionConfig((prev) => ({
                            ...prev,
                            profile: 'custom',
                            writableRoots: event.target.value
                              .split('\n')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          }))
                        }
                        rows={3}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                        placeholder={"/data1/ai-services/deepseek_ocr\n/data/cache/modelscope\n/tmp"}
                      />
                    </label>

                    {draftPermissionSupport ? (
                      <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-[11px] text-slate-600">
                        <div className="font-medium text-slate-800">当前生效范围</div>
                        <div className="mt-1 leading-5">{draftPermissionSupport.summary}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {draftPermissionStatusItems.map((item) => (
                            <span
                              key={item.key}
                              className={`rounded-full px-2.5 py-1 ring-1 ${permissionSupportTone[item.state]}`}
                            >
                              {item.label}: {getPermissionSupportLabel(item.state)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="sticky bottom-0 mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/95 pt-3">
                      {permissionConfigNotice ? (
                        <div className="text-[11px] text-slate-600">{permissionConfigNotice}</div>
                      ) : (
                        <div className="text-[11px] text-slate-500">
                          {selectedRun?.status === 'running' || selectedRun?.status === 'waiting_for_input'
                            ? '当前权限变更不会影响正在执行的 session。'
                            : '保存后会在下一次新 run 或 continuation 生效。'}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => void handlePermissionConfigSave()}
                          disabled={isSavingPermissionConfig}
                          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          {isSavingPermissionConfig ? '保存中...' : '仅保存配置'}
                        </button>
                        <button
                          onClick={() => void handleExecuteTask()}
                          disabled={isExecuting}
                          className="rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                        >
                          {isExecuting ? '启动中...' : '用当前配置启动新 Run'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="rounded-[22px] border border-slate-200 bg-white px-3 py-2 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
                  <textarea
                    value={messageInput}
                    onChange={(event) => setMessageInput(event.target.value)}
                    rows={1}
                    className="w-full resize-none border-0 bg-transparent px-1.5 py-1 text-[13px] text-slate-900 outline-none focus:ring-0"
                    placeholder={
                      conversationMode === 'chat'
                        ? '先把你的想法、澄清、计划或指令发到 task room……'
                        : activeRunSummary
                        ? '当前已有 active run；如需介入，请先用控制按钮处理它……'
                        : '输入本轮要执行的最新指令；发送时会一并带上当前对话上下文……'
                    }
                  />
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[10px] text-slate-500">
                      {conversationMode === 'chat'
                        ? activeRunSummary
                          ? '当前有 active run，新消息会先排队写入 task room，不会实时直达目标参与方。'
                          : canContinueSelectedSession
                          ? '会继续当前已保存的 agent 会话。'
                          : '会直接启动新的 agent 回复。'
                        : activeRunSummary
                        ? '当前有 active run，暂时不能再启动。'
                        : '会带着当前对话启动新 run。'}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void handleAcpxControl('interrupt_now', 'immediate')}
                        disabled={
                          isSending
                          || !taskRoom
                          || !controlRunCanInterrupt
                          || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                        }
                        className="rounded-full border border-amber-300 bg-amber-50 px-3.5 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-amber-200 disabled:text-amber-400"
                      >
                        打断并转入下一轮
                      </button>
                      <button
                        onClick={() => void handleAcpxControl('stop_run', 'immediate')}
                        disabled={isSending || !taskRoom || !controlRunCanStop}
                        className="rounded-full border border-rose-300 bg-rose-50 px-3.5 py-1.5 text-xs font-medium text-rose-800 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-rose-200 disabled:text-rose-400"
                      >
                        停止运行
                      </button>
                      <button
                        onClick={() => void handlePrimaryAcpxSend()}
                        disabled={
                          isSending
                          || (conversationMode === 'run' && (!canExecute || isExecuting))
                          || !taskRoom
                          || (conversationMode === 'run' ? false : !messageInput.trim())
                          || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                        }
                        className="rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {isSending || isExecuting ? '处理中...' : primarySendLabel}
                      </button>
                      {conversationMode === 'run' && canContinueSelectedSession && !activeRunSummary ? (
                        <button
                          onClick={() => void handleAcpxControl('continue_session', 'immediate')}
                          disabled={
                            isSending
                            || !taskRoom
                            || !messageInput.trim()
                            || (messageTargetType === 'participant' && !messageTargetParticipantKey)
                          }
                          className="rounded-full border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          继续当前会话
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                {controlError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
                    {controlError}
                  </div>
                ) : null}
                {composerNotice ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
                    {composerNotice}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mx-auto max-w-4xl space-y-3">
                <div className="rounded-[24px] border border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_30px_rgba(15,23,42,0.06)]">
                  <textarea
                    value={messageInput}
                    onChange={(event) => setMessageInput(event.target.value)}
                    rows={2}
                    className="w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-0"
                    placeholder="输入消息……"
                  />
                  <div className="mt-2.5 flex justify-end">
                    <button
                      onClick={() => void handleSendMessage()}
                      disabled={isSending || !taskRoom || !messageInput.trim()}
                      className="rounded-full bg-slate-900 px-5 py-2.5 text-sm text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      {isSending ? '发送中...' : primarySendLabel}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

  );
}
