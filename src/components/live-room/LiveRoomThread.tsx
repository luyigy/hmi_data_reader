'use client';

import {
  getAttentionLabel,
  getComposerModeLabel,
  getDirectedTargetMember,
  getMemberLabel,
  getMemberSubtitle,
  getMessageMetadataValue,
  getPendingReplyStatusLabel,
  renderLiveRoomSystemMessage,
} from './live-room-workspace-models';
import { useLiveRoomContext } from './live-room-context';

export function LiveRoomThread() {
  const {
    selectedRoom, initialRoomId, isRoomsPanelOpen, setIsRoomsPanelOpen,
    selectedSpeaker, isDetailsPanelOpen, setIsDetailsPanelOpen,
    messageViewportRef, handleMessageViewportScroll, isLoadingRoom, messages,
    selectedTargetMemberId, setSelectedTargetMemberId, activeReplyMembers,
    draftMentionAll, draftMentionMemberIds, messageInput, handleComposerChange,
    handleComposerKeyDown, mentionCandidates, handlePickMention, isSending,
    handleSendMessage, notice, dismissedNotice, setDismissedNotice,
    pendingSummaryText, dismissedPendingSummary, setDismissedPendingSummary,
    handleInterruptPendingReply, interruptingMemberId, error,
  } = useLiveRoomContext();

  return (
      <section className="grid min-h-0 grid-rows-[auto,minmax(0,1fr),auto] bg-[#fcfcfd]">
        {!selectedRoom && !initialRoomId ? (
          <div className="flex h-full items-center justify-center px-10">
            <div className="max-w-2xl text-center">
              <div className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">Workspace</div>
              <h1 className="mt-4 text-4xl font-semibold text-slate-900">像 Codex Desktop 一样进入持续协作项目</h1>
              <p className="mt-4 text-base leading-7 text-slate-600">
                先创建 workspace、邀请来自任意 gateway 的 agent，然后在中间持续推进 topic。
                这里的主语义是项目、线程和同步入口，不再只是 run 控制台。
              </p>
              {!isRoomsPanelOpen ? (
                <button
                  onClick={() => setIsRoomsPanelOpen(true)}
                  className="mt-6 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  显示 Workspaces
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <header className="border-b border-slate-200 bg-white px-6 py-3">
              <div className="flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Workspace Thread</div>
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    <h1 className="truncate text-[24px] font-semibold text-slate-950">{selectedRoom?.title || '加载中...'}</h1>
                    <span className="max-w-full truncate text-sm text-slate-600">
                      topic: {selectedRoom?.currentTopic || '未设置'}
                    </span>
                    <span className="max-w-full truncate text-sm text-slate-600">
                      speaker: {selectedSpeaker ? getMemberLabel(selectedSpeaker) : '未选择'}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full bg-slate-100 px-3 py-1">{selectedRoom?.mode || 'discussion'}</span>
                  <span className="rounded-full bg-slate-100 px-3 py-1">{selectedRoom?.memberCount || 0} members</span>
                  {selectedRoom ? (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">
                      {getAttentionLabel(selectedRoom.attentionState)}
                    </span>
                  ) : null}
                  {selectedRoom?.linkedChannels.some((channel) => channel.kind === 'feishu_chat') ? (
                    <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-700">
                      Feishu linked
                    </span>
                  ) : null}
                  {!isRoomsPanelOpen ? (
                    <button
                      onClick={() => setIsRoomsPanelOpen(true)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      显示 Workspaces
                    </button>
                  ) : null}
                  {!isDetailsPanelOpen ? (
                    <button
                      onClick={() => setIsDetailsPanelOpen(true)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      显示详情
                    </button>
                  ) : null}
                </div>
              </div>
            </header>

            <div
              ref={messageViewportRef}
              onScroll={handleMessageViewportScroll}
              className="min-h-0 overflow-y-auto px-5 py-3"
            >
              {isLoadingRoom ? (
                <div className="text-sm text-slate-500">加载房间内容中...</div>
              ) : messages.length === 0 ? (
                <div className="mx-auto max-w-3xl rounded-[28px] border border-dashed border-slate-300 bg-white px-8 py-12 text-center text-sm text-slate-500">
                  这间房还没有消息。先设定一个 topic，然后从底部开始对话。
                </div>
              ) : (
                <div className="mx-auto flex max-w-4xl flex-col gap-3 pb-1">
                  {messages.map((message) => {
                    const isUser = message.senderType === 'user';
                    const isAssistant = message.messageType === 'assistant';
                    const isSystem = message.messageType === 'system' || message.messageType === 'topic';
                    const deliveryIntent = getMessageMetadataValue(message, 'deliveryIntent');
                    const isDirectedVisible = deliveryIntent === 'directed_visible' || message.visibility === 'directed_visible';
                    const directedTargetMember = getDirectedTargetMember(message, selectedRoom);

                    if (isSystem) {
                      const customSystemMessage = renderLiveRoomSystemMessage(message, selectedRoom);
                      if (customSystemMessage) {
                        return <div key={message.id}>{customSystemMessage}</div>;
                      }

                      return (
                        <div key={message.id} className="mx-auto max-w-2xl rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
                          {message.content}
                        </div>
                      );
                    }

                    return (
                      <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[82%] rounded-[24px] px-4 py-3 shadow-sm ${
                          isUser
                            ? 'bg-[#111827] text-white'
                            : isAssistant
                            ? 'bg-white text-slate-900 ring-1 ring-slate-200'
                            : 'bg-slate-100 text-slate-900'
                        }`}>
                          <div className={`mb-1 flex flex-wrap items-center gap-1.5 text-[10px] ${isUser ? 'text-slate-300' : 'text-slate-500'}`}>
                            <span>
                              {message.senderLabel || message.senderName}
                              {isDirectedVisible && directedTargetMember ? ` -> ${directedTargetMember.displayName}` : ''}
                            </span>
                            <span>· {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                          </div>
                          {Array.isArray(getMessageMetadataValue(message, 'mentionedMemberIds')) || getMessageMetadataValue(message, 'primaryTargetMemberId') || getMessageMetadataValue(message, 'mentionedAll') ? (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {typeof deliveryIntent === 'string' ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  {String(deliveryIntent)}
                                </span>
                              ) : null}
                              {isDirectedVisible ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-emerald-400/20 text-emerald-100' : 'bg-emerald-100 text-emerald-700'
                                }`}>
                                  room-visible direct
                                </span>
                              ) : null}
                              {getMessageMetadataValue(message, 'mentionedAll') ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  $all
                                </span>
                              ) : null}
                              {Array.isArray(getMessageMetadataValue(message, 'expectedResponderMemberIds'))
                                && getMessageMetadataValue(message, 'mentionedAll') ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  queued: {(getMessageMetadataValue(message, 'expectedResponderMemberIds') as unknown[]).length}
                                </span>
                              ) : null}
                              {selectedRoom?.members
                                .filter((member) => member.id === getMessageMetadataValue(message, 'primaryTargetMemberId'))
                                .map((member) => (
                                  <span
                                    key={`${message.id}:${member.id}:primary`}
                                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                                      isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                    }`}
                                  >
                                    target: {member.displayName}
                                  </span>
                                ))}
                              {selectedRoom?.members
                                .filter((member) => {
                                  const mentionedMemberIds = getMessageMetadataValue(message, 'mentionedMemberIds');
                                  return Array.isArray(mentionedMemberIds) && mentionedMemberIds.includes(member.id);
                                })
                                .map((member) => (
                                  <span
                                    key={`${message.id}:${member.id}`}
                                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                                      isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                    }`}
                                  >
                                    @{member.displayName}
                                  </span>
                                ))}
                            </div>
                          ) : null}
                          <div className="whitespace-pre-wrap break-words text-[14px] leading-6">
                            {message.content}
                          </div>
                          {isAssistant && Array.isArray(message.metadata?.footnotes) ? (
                            <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-5 text-slate-500 break-words">
                              {message.metadata.footnotes.filter((line): line is string => typeof line === 'string').map((line, index) => <div key={index}>{line}</div>)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 bg-white px-6 py-2.5">
              <div className="mx-auto max-w-4xl rounded-[22px] border border-slate-200 bg-white px-4 py-2.5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <select
                    value={selectedTargetMemberId}
                    onChange={(event) => setSelectedTargetMemberId(event.target.value)}
                    className="rounded-full border border-slate-300 px-3 py-1.5 text-xs text-slate-700"
                  >
                    <option value="">向整个房间说话（由当前 speaker 优先回应）</option>
                    {activeReplyMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {getMemberLabel(member)}
                      </option>
                    ))}
                  </select>
                  <div className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
                    {draftMentionAll
                      ? '这条消息带有 $all，当前房间内所有可回复成员都会收到并按顺序回应。'
                      : draftMentionMemberIds.length > 0
                      ? '这条消息包含结构化 mention，本次会优先按 mention 路由。'
                      : selectedTargetMemberId
                      ? '这是一条房间可见的定向消息，只有 dropdown 里选中的 agent 会把它作为直接输入。'
                      : '这是一条面向整个房间的公开消息，当前 speaker 会优先回复。'}
                  </div>
                </div>
                <textarea
                  value={messageInput}
                  onChange={(event) => handleComposerChange(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder="向房间继续说点什么，可以直接 @agent 或点名某个 agent..."
                  className="min-h-[44px] w-full resize-none border-0 bg-transparent px-1 py-0.5 text-[14px] text-slate-900 outline-none"
                />
                {mentionCandidates.length > 0 ? (
                  <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                    <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Mention</div>
                    <div className="space-y-1">
                      {mentionCandidates.map((member) => (
                        <button
                          key={member.kind === 'all' ? member.id : member.member.id}
                          onClick={() => handlePickMention(member)}
                          onMouseDown={(event) => event.preventDefault()}
                          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition hover:bg-white"
                          type="button"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-800">
                              {member.kind === 'all' ? member.label : member.member.displayName}
                            </div>
                            <div className="truncate text-[11px] text-slate-500">
                              {member.kind === 'all' ? member.subtitle : getMemberSubtitle(member.member)}
                            </div>
                          </div>
                          <span className="rounded-full bg-white px-2 py-1 text-[10px] text-slate-500">
                            {member.kind === 'all' ? '$all' : `$${member.member.displayName}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="mt-1.5 flex items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">
                      mode: {getComposerModeLabel({
                        draftMentionAll,
                        draftMentionMemberIds,
                        selectedTargetMemberId,
                      })}
                    </span>
                    {draftMentionAll && selectedRoom
                      ? `已结构化 mention：$all（${selectedRoom.members.filter((member) => member.canReply && member.memberType !== 'user').length} 个可回复成员）`
                      : draftMentionMemberIds.length > 0 && selectedRoom
                      ? `已结构化 mention：${draftMentionMemberIds.map((memberId) => selectedRoom.members.find((member) => member.id === memberId)?.displayName).filter(Boolean).join('、')}`
                      : selectedSpeaker
                      ? `当前主回复 agent：${getMemberLabel(selectedSpeaker)}`
                      : '还没有 speaker，先在右侧选择一个可回复成员。'}
                    {selectedRoom?.pendingReplies?.length
                      ? ` 正在等待：${selectedRoom.pendingReplies.map((reply) => (
                        `${reply.displayName} (${getPendingReplyStatusLabel(reply)})`
                      )).join('、')}`
                      : selectedRoom?.pendingReplyCount
                      ? ` 正在等待：${(selectedRoom.pendingReplyTargetNames || []).join('、') || `${selectedRoom.pendingReplyCount} 个 agent`}`
                      : ''}
                  </div>
                  <button
                    onClick={() => void handleSendMessage()}
                    disabled={isSending || !messageInput.trim()}
                    className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
                  >
                    {isSending ? '发送中...' : '发送'}
                  </button>
                </div>
              </div>
              {notice && notice !== dismissedNotice ? (
                <div className="mx-auto mt-2 flex max-w-4xl items-start justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
                  <div className="min-w-0 flex-1">{notice}</div>
                  <button
                    type="button"
                    onClick={() => setDismissedNotice(notice)}
                    className="shrink-0 rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-100"
                    aria-label="Dismiss notice"
                  >
                    x
                  </button>
                </div>
              ) : null}
              {pendingSummaryText && pendingSummaryText !== dismissedPendingSummary ? (
                <div className="mx-auto mt-2 flex max-w-4xl items-start justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-700">
                  <div className="min-w-0 flex-1">
                    <div>{pendingSummaryText}。页面会轻量自动刷新。</div>
                    {selectedRoom?.pendingReplies?.some((reply) => reply.interruptSupported && reply.runningCount > 0) ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedRoom.pendingReplies
                          .filter((reply) => reply.interruptSupported && reply.runningCount > 0)
                          .map((reply) => (
                            <button
                              key={`interrupt:${reply.memberId}`}
                              type="button"
                              onClick={() => void handleInterruptPendingReply(reply)}
                              disabled={interruptingMemberId === reply.memberId}
                              className="rounded-full border border-sky-300 bg-white px-3 py-1 text-[11px] font-medium text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:text-sky-400"
                            >
                              {interruptingMemberId === reply.memberId
                                ? `中断 ${reply.displayName} 中...`
                                : `中断 ${reply.displayName}`}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDismissedPendingSummary(pendingSummaryText)}
                    className="shrink-0 rounded-full border border-sky-300 bg-white px-2 py-0.5 text-[11px] font-medium text-sky-700 transition hover:bg-sky-100"
                    aria-label="Dismiss pending summary"
                  >
                    x
                  </button>
                </div>
              ) : null}
              {error ? (
                <div className="mx-auto mt-2 max-w-4xl rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
                  {error}
                </div>
              ) : null}
            </div>
          </>
        )}
      </section>
  );
}
