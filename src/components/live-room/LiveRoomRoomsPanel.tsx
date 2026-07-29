'use client';

import Link from 'next/link';
import {
  MEMBER_ROLES,
  PERMISSION_PROFILES,
  getAttentionLabel,
  getPermissionProfileLabel,
  getWorkspaceStatusLabel,
} from './live-room-workspace-models';
import { useLiveRoomContext } from './live-room-context';

export function LiveRoomRoomsPanel() {
  const {
    isRoomsPanelOpen, setIsRoomsPanelOpen, newRoomTitle, setNewRoomTitle,
    newRoomTopic, setNewRoomTopic, newRoomWorkingDirectory, setNewRoomWorkingDirectory,
    availableAgents, selectedAgentIds, setSelectedAgentIds, selectedAgentRoles,
    setSelectedAgentRoles, selectedAgentPermissions, setSelectedAgentPermissions,
    handleCreateRoom, isCreating, isLoadingRooms, rooms, activeRooms, selectedRoom,
    initialRoomId, basePath, openRoomActionsId, setOpenRoomActionsId,
    handleOpenRoomSettingsFromList, handleArchiveRoomById, isArchivingRoom,
    archivedRooms, showArchivedRooms, setShowArchivedRooms,
    handleHardDeleteRoomById, isDeletingRoom,
  } = useLiveRoomContext();

  return (
    <>
      {isRoomsPanelOpen ? (
        <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-[#f7f7f8]">
          <div className="border-b border-slate-200 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Workspaces</div>
                <div className="mt-2 text-lg font-semibold text-slate-900">项目工作空间</div>
              </div>
              <button
                onClick={() => setIsRoomsPanelOpen(false)}
                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
              >
                隐藏
              </button>
            </div>
          </div>

          <div className="border-b border-slate-200 px-4 py-4">
            <div className="text-sm font-medium text-slate-900">新建 Workspace</div>
            <input
              value={newRoomTitle}
              onChange={(event) => setNewRoomTitle(event.target.value)}
              placeholder="例如：跨网关 OCR 工作空间"
              className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <textarea
              value={newRoomTopic}
              onChange={(event) => setNewRoomTopic(event.target.value)}
              rows={2}
              placeholder="给这个 workspace 一个当前 topic / task..."
              className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <input
              value={newRoomWorkingDirectory}
              onChange={(event) => setNewRoomWorkingDirectory(event.target.value)}
              placeholder="工作目录，例如 /data1/code/defects-detection"
              className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2">
              {availableAgents.map((agent) => {
                const checked = selectedAgentIds.includes(agent.id);
                return (
                  <div key={agent.id} className="flex items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedAgentIds((prev) => checked
                          ? prev.filter((item) => item !== agent.id)
                          : [...prev, agent.id]
                        )
                      }
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800">{agent.agentName || agent.label}</div>
                      <div className="text-[11px] text-slate-500">{agent.gatewayName} / {agent.harnessType}</div>
                    </div>
                    {checked ? (
                      <div className="ml-auto flex gap-1">
                        <select
                          value={selectedAgentRoles[agent.id] || 'custom'}
                          onChange={(event) => setSelectedAgentRoles((roles) => ({ ...roles, [agent.id]: event.target.value }))}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-[11px]"
                        >
                          {MEMBER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                        </select>
                        <select
                          value={selectedAgentPermissions[agent.id] || 'safe_local'}
                          onChange={(event) => setSelectedAgentPermissions((permissions) => ({ ...permissions, [agent.id]: event.target.value }))}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-[11px]"
                        >
                          {PERMISSION_PROFILES.map((profile) => (
                            <option key={profile} value={profile}>{getPermissionProfileLabel(profile)}</option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => void handleCreateRoom()}
              disabled={isCreating}
              className="mt-3 w-full rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
            >
              {isCreating ? '创建中...' : '创建 Workspace'}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {isLoadingRooms ? (
              <div className="px-3 py-4 text-sm text-slate-500">加载 workspaces 中...</div>
            ) : rooms.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-500">还没有 workspace，先创建一个。</div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  {activeRooms.map((room) => {
                    const isActive = room.id === selectedRoom?.id || room.id === initialRoomId;
                    return (
                      <div
                        key={room.id}
                        className={`relative rounded-2xl px-3 py-3 transition ${
                          isActive ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white/70'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <Link
                            href={`${basePath}/${room.id}`}
                            className="min-w-0 flex-1"
                          >
                            <div className="truncate text-sm font-medium text-slate-900">{room.title}</div>
                            <div className="mt-1 truncate text-xs text-slate-500">{room.currentTopic || '暂未设置 topic'}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                                {getWorkspaceStatusLabel(room.workspaceStatus)}
                              </span>
                              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                                {getAttentionLabel(room.attentionState)}
                              </span>
                              {room.linkedChannels.some((channel) => channel.kind === 'feishu_chat') ? (
                                <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                                  Feishu
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                              <span>{room.memberCount} members</span>
                              <span className="truncate">{room.currentSpeakerName || '无 speaker'}</span>
                            </div>
                          </Link>
                          <div className="relative shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                setOpenRoomActionsId((current) => current === room.id ? null : room.id)
                              }
                              className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                              aria-label={`Open actions for ${room.title}`}
                            >
                              ...
                            </button>
                            {openRoomActionsId === room.id ? (
                              <div className="absolute right-0 top-10 z-10 w-40 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => void handleOpenRoomSettingsFromList(room.id)}
                                  className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleArchiveRoomById(room.id, room.title)}
                                  disabled={isArchivingRoom}
                                  className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50 disabled:text-rose-300"
                                >
                                  Archive
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white/60">
                  <button
                    type="button"
                    onClick={() => setShowArchivedRooms((current) => !current)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left"
                  >
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                      Archived Workspaces
                    </span>
                    <span className="text-xs text-slate-500">
                      {archivedRooms.length} {showArchivedRooms ? 'hide' : 'show'}
                    </span>
                  </button>
                  {showArchivedRooms ? (
                    archivedRooms.length === 0 ? (
                      <div className="px-3 pb-3 text-sm text-slate-500">还没有 archived workspaces。</div>
                    ) : (
                      <div className="space-y-1 px-2 pb-2">
                        {archivedRooms.map((room) => {
                          const isActive = room.id === selectedRoom?.id || room.id === initialRoomId;
                          return (
                            <div
                              key={room.id}
                              className={`relative rounded-2xl px-3 py-3 transition ${
                                isActive ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white/70'
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                <Link
                                  href={`${basePath}/${room.id}`}
                                  className="min-w-0 flex-1"
                                >
                                  <div className="truncate text-sm font-medium text-slate-700">{room.title}</div>
                                  <div className="mt-1 truncate text-xs text-slate-500">{room.currentTopic || '暂未设置 topic'}</div>
                                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                                    <span>{room.memberCount} members</span>
                                    <span className="truncate">archived</span>
                                  </div>
                                </Link>
                                <div className="relative shrink-0">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setOpenRoomActionsId((current) => current === room.id ? null : room.id)
                                    }
                                    className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                                    aria-label={`Open actions for ${room.title}`}
                                  >
                                    ...
                                  </button>
                                  {openRoomActionsId === room.id ? (
                                    <div className="absolute right-0 top-10 z-10 w-44 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg">
                                      <button
                                        type="button"
                                        onClick={() => void handleOpenRoomSettingsFromList(room.id)}
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        disabled
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-300"
                                      >
                                        Archived
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void handleHardDeleteRoomById(room.id, room.title)}
                                        disabled={isDeletingRoom}
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50 disabled:text-rose-300"
                                      >
                                        Delete Permanently
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </aside>
      ) : null}
    </>
  );
}
