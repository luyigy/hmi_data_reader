'use client';

import {
  CODEX_REASONING_EFFORTS,
  MEMBER_ROLES,
  PERMISSION_PROFILES,
  getAgentLabel,
  getMemberSubtitle,
  getPermissionBadgeTone,
  getPermissionProfileLabel,
  getWatermarkPolicyLabel,
  getWatermarkPolicyTone,
  getWatermarkTooltip,
  getWatermarkUsageBarTone,
  getWatermarkUsageLabel,
} from './live-room-workspace-models';
import { useLiveRoomContext } from './live-room-context';

export function LiveRoomDetailsPanel() {
  const {
    isDetailsPanelOpen, setIsDetailsPanelOpen, selectedRoom,
    roomTitleDraft, setRoomTitleDraft, roomDescriptionDraft, setRoomDescriptionDraft,
    roomModeDraft, setRoomModeDraft, handleSaveRoomSettings, isSavingRoomSettings,
    handleArchiveRoom, isArchivingRoom, handleHardDeleteRoom, isDeletingRoom,
    topicDraft, setTopicDraft, handleUpdateTopic, activeReplyMembers,
    handleSetSpeaker, handleUpdateMemberRole, handleUpdateMemberPermission,
    handleUpdateCodexSettings, memberToAdd, setMemberToAdd, addableAgents,
    memberRoleToAdd, setMemberRoleToAdd, memberPermissionToAdd,
    setMemberPermissionToAdd, handleAddMember,
  } = useLiveRoomContext();

  return (
    <>
      {isDetailsPanelOpen ? (
        <aside className="min-h-0 overflow-y-auto border-l border-slate-200 bg-[#fafafa] px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Room Details</div>
            <button
              onClick={() => setIsDetailsPanelOpen(false)}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              隐藏
            </button>
          </div>
          {!selectedRoom ? (
            <div className="mt-4 text-sm text-slate-500">选择或创建一个房间后，这里会显示 topic、speaker 和成员信息。</div>
          ) : (
            <div className="space-y-5">
              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-900">房间设置</div>
                <div className="mt-3 space-y-3">
                  <label className="block">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">Title</div>
                    <input
                      value={roomTitleDraft}
                      onChange={(event) => setRoomTitleDraft(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    />
                  </label>
                  <label className="block">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">Description</div>
                    <textarea
                      value={roomDescriptionDraft}
                      onChange={(event) => setRoomDescriptionDraft(event.target.value)}
                      rows={3}
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    />
                  </label>
                  <label className="block">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">Mode</div>
                    <select
                      value={roomModeDraft}
                      onChange={(event) => setRoomModeDraft(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="discussion">discussion</option>
                      <option value="execution">execution</option>
                      <option value="hybrid">hybrid</option>
                    </select>
                    <div className="mt-2 text-[11px] leading-5 text-slate-500">
                      discussion：仅定向成员或当前 speaker 回复；execution：按 planner → researcher → implementer → reviewer → tester 顺序；hybrid：平时 discussion，发送 `/run ...` 时启动角色队列。
                    </div>
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => void handleSaveRoomSettings()}
                    disabled={isSavingRoomSettings}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:text-slate-400"
                  >
                    {isSavingRoomSettings ? '保存中...' : '保存房间设置'}
                  </button>
                  <button
                    onClick={() => void handleArchiveRoom()}
                    disabled={isArchivingRoom}
                    className="rounded-full border border-rose-300 bg-white px-4 py-2 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:text-rose-300"
                  >
                    {isArchivingRoom ? '归档中...' : '归档房间'}
                  </button>
                  {selectedRoom.status === 'archived' ? (
                    <button
                      onClick={() => void handleHardDeleteRoom()}
                      disabled={isDeletingRoom}
                      className="rounded-full border border-rose-500 bg-rose-50 px-4 py-2 text-xs font-medium text-rose-800 transition hover:bg-rose-100 disabled:text-rose-300"
                    >
                      {isDeletingRoom ? '删除中...' : '永久删除'}
                    </button>
                  ) : null}
                </div>
              </section>

              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-900">当前 Topic</div>
                <textarea
                  value={topicDraft}
                  onChange={(event) => setTopicDraft(event.target.value)}
                  rows={4}
                  className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
                <button
                  onClick={() => void handleUpdateTopic()}
                  className="mt-3 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  保存 Topic
                </button>
              </section>

              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-900">当前 Speaker</div>
                <div className="mt-3 space-y-2">
                  {activeReplyMembers.map((member) => {
                    const isActive = member.id === selectedRoom.currentSpeakerMemberId;
                    return (
                      <button
                        key={member.id}
                        onClick={() => void handleSetSpeaker(member.id)}
                        className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition ${
                          isActive ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-800 hover:bg-slate-100'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{member.displayName}</div>
                          <div className={`mt-0.5 text-[11px] ${isActive ? 'text-slate-300' : 'text-slate-500'}`}>
                            {getMemberSubtitle(member)}
                          </div>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] ${isActive ? 'bg-white/10 text-white' : 'bg-white text-slate-500'}`}>
                          {member.presenceStatus}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-900">房间成员</div>
                  <a
                    href="/agents"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                  >
                    管理昵称 →
                  </a>
                </div>
                <div className="mt-3 space-y-2">
                  {selectedRoom.members.map((member) => (
                    <div key={member.id} className="rounded-2xl bg-slate-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium text-slate-800">{member.displayName}</div>
                        <div className="flex shrink-0 items-center gap-2">
                          {member.permissionLabel ? (
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getPermissionBadgeTone(member.permissionProfile)}`}>
                              {member.permissionLabel}
                            </span>
                          ) : null}
                          {member.contextWatermark ? (
                            <>
                              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600">
                                {getWatermarkUsageLabel(member)}
                              </span>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getWatermarkPolicyTone(member.contextWatermark.policyStatus)}`}>
                                {getWatermarkPolicyLabel(member)}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {getMemberSubtitle(member)}
                      </div>
                      {member.memberType !== 'user' ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <select
                            value={member.role}
                            onChange={(event) => void handleUpdateMemberRole(member.id, event.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px]"
                          >
                            {MEMBER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                          </select>
                          <select
                            value={member.permissionProfile || 'safe_local'}
                            onChange={(event) => void handleUpdateMemberPermission(member.id, event.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px]"
                          >
                            {PERMISSION_PROFILES.map((profile) => (
                              <option key={profile} value={profile}>{getPermissionProfileLabel(profile)}</option>
                            ))}
                          </select>
                          {member.harnessType === 'codex' ? (
                            <>
                              <input
                                key={`${member.id}:${member.codexModel || ''}`}
                                defaultValue={member.codexModel || ''}
                                placeholder="Model (inherit)"
                                onBlur={(event) => {
                                  if (event.target.value.trim() !== (member.codexModel || '')) {
                                    void handleUpdateCodexSettings(member.id, { codexModel: event.target.value });
                                  }
                                }}
                                className="w-36 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px]"
                              />
                              <select
                                value={member.codexReasoningEffort || ''}
                                onChange={(event) => void handleUpdateCodexSettings(member.id, {
                                  codexReasoningEffort: event.target.value,
                                })}
                                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px]"
                              >
                                <option value="">Thinking (inherit)</option>
                                {CODEX_REASONING_EFFORTS.map((effort) => (
                                  <option key={effort} value={effort}>{effort}</option>
                                ))}
                              </select>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                      {member.contextWatermark ? (
                        <div className="mt-2" title={getWatermarkTooltip(member)}>
                          {member.contextWatermark.usagePercentage != null ? (
                            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                              <div
                                className={`h-full rounded-full ${getWatermarkUsageBarTone(member.contextWatermark.usageStatus)}`}
                                style={{ width: `${Math.min(100, Math.max(0, member.contextWatermark.usagePercentage))}%` }}
                              />
                            </div>
                          ) : null}
                          <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                            <span>{getWatermarkUsageLabel(member)}</span>
                            <span>{member.contextWatermark.dominantLabel}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="mt-4 border-t border-slate-200 pt-4">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">Add Member</div>
                  <select
                    value={memberToAdd}
                    onChange={(event) => setMemberToAdd(event.target.value)}
                    className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="">选择一个可加入的 agent</option>
                    {addableAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {getAgentLabel(agent)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={memberRoleToAdd}
                    onChange={(event) => setMemberRoleToAdd(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  >
                    {MEMBER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <select
                    value={memberPermissionToAdd}
                    onChange={(event) => setMemberPermissionToAdd(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  >
                    {PERMISSION_PROFILES.map((profile) => (
                      <option key={profile} value={profile}>{getPermissionProfileLabel(profile)}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => void handleAddMember()}
                    disabled={!memberToAdd}
                    className="mt-3 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:text-slate-400"
                  >
                    添加成员
                  </button>
                </div>
              </section>
            </div>
          )}
        </aside>
      ) : null}
    </>
  );
}
