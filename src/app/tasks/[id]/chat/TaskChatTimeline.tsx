'use client';

import { useMemo } from 'react';
import { taskRoomUser } from './task-chat-types';
import { useTaskChat } from './task-chat-context';
import { CollapsibleExecutionBlock } from './CollapsibleExecutionBlock';
import type { ConversationFeedItem } from './task-chat-types';

/** Group consecutive run_event items into blocks for folding. */
function groupFeedForFolding(feed: ConversationFeedItem[]): Array<ConversationFeedItem | ConversationFeedItem[]> {
  const result: Array<ConversationFeedItem | ConversationFeedItem[]> = [];
  let pendingEvents: ConversationFeedItem[] = [];

  const flush = () => {
    if (pendingEvents.length > 0) {
      result.push([...pendingEvents]);
      pendingEvents = [];
    }
  };

  for (const item of feed) {
    if (item.type === 'run_event' && item.runEvent) {
      // Skip live streaming summary duplicates
      if (
        item.runEvent.eventType === 'summary'
        && item.runEvent.metadata
        && item.runEvent.metadata.streamingMode === 'live'
      ) {
        continue;
      }
      pendingEvents.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();

  return result;
}

/** Check if a group of items has any detail-tier events that would benefit from folding */
function groupHasDetail(items: ConversationFeedItem[]): boolean {
  return items.some(
    (item) => item.runEvent?.tier === 'detail'
  );
}

export function TaskChatTimeline() {
  const { timelineContainerRef, handleTimelineScroll, task, standardMessages, conversationFeed } = useTaskChat();

  const groupedFeed = useMemo(() => groupFeedForFolding(conversationFeed), [conversationFeed]);

  if (!task) return null;
  return (
          <div
            ref={timelineContainerRef}
            onScroll={handleTimelineScroll}
            className="min-h-0 overflow-y-auto px-3 py-4 xl:px-6"
          >
            {task.executionMode !== 'acpx' ? (
              <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
                {standardMessages.map((message) => (
                  <div key={message.id} className="rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                    <div className="mb-1 text-xs text-slate-500">
                      {new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false })}
                      {message.senderName ? ` · ${message.senderName}` : ''}
                    </div>
                    <div className={message.messageType === 'error' ? 'text-red-600' : 'text-slate-900'}>
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>
            ) : conversationFeed.length === 0 ? (
              <div className="mx-auto max-w-3xl rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-8 text-sm text-slate-500 shadow-sm">
                还没有消息或运行事件。你可以先发一条消息，然后平台会在这里持续展示对话和运行过程。
              </div>
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
                {groupedFeed.map((group) => {
                  // Single room_message item
                  if (!Array.isArray(group) && group.type === 'room_message' && group.roomMessage) {
                    const message = group.roomMessage;
                    const isOwn = message.user.id === taskRoomUser.id;
                    const isSystemMessage = message.user.id === 'system';

                    if (isSystemMessage) return null;

                    const bubbleClass = isOwn
                      ? 'ml-auto bg-[#111827] text-white'
                      : 'bg-white text-slate-900 ring-1 ring-slate-200';

                    return (
                      <div
                        key={group.id}
                        className={`max-w-[85%] rounded-[24px] px-4 py-3 shadow-sm ${bubbleClass}`}
                      >
                        <div className={`mb-1 text-[11px] ${isOwn ? 'text-slate-300' : 'text-slate-500'}`}>
                          {message.user.name} · {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        </div>
                        {message.target.type !== 'task' ? (
                          <div className={`mb-1.5 text-[10px] ${isOwn ? 'text-slate-300' : 'text-slate-500'}`}>
                            {message.target.type === 'all'
                              ? '发给：全部参与方'
                              : `发给：${message.target.participantLabel || '指定参与方'}`}
                          </div>
                        ) : null}
                        <div className="whitespace-pre-wrap break-words text-[13px] leading-6">{message.content}</div>
                      </div>
                    );
                  }

                  // Event group (array)
                  if (Array.isArray(group) && group.length > 0) {
                    const hasDetail = groupHasDetail(group);

                    if (hasDetail) {
                      return (
                        <CollapsibleExecutionBlock
                          key={group[0].id}
                          items={group}
                          summaryCount={1}
                        />
                      );
                    }

                    // No detail events — render flat
                    return group.map((item) => {
                      const event = item.runEvent;
                      if (!event) return null;

                      if (event.eventType === 'session_continuation_started') {
                        return (
                          <div key={item.id} className="mx-auto max-w-2xl">
                            <div className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-center text-xs text-sky-800 shadow-sm">
                              {event.content}
                            </div>
                          </div>
                        );
                      }

                      const isSystemEvent =
                        event.eventType === 'session_continuation_started'
                        || event.eventType === 'control_message';
                      const eventToneClass = isSystemEvent
                        ? 'border-amber-200 bg-amber-50/80'
                        : 'border-slate-200/80 bg-white/88';

                      return (
                        <div
                          key={item.id}
                          className={`rounded-[18px] border px-3.5 py-2.5 shadow-sm ${eventToneClass}`}
                        >
                          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                            <span>{new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{event.eventType}</span>
                            {event.participant ? (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                                {event.participant.role} · {event.participant.executionBackend === 'platform_local' ? 'Platform Local' : event.participant.gatewayName} / {event.participant.harnessType}
                              </span>
                            ) : null}
                          </div>
                          <pre className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-5 ${event.stream === 'stderr' ? 'text-red-600' : 'text-slate-800'}`}>
                            {event.content}
                          </pre>
                        </div>
                      );
                    });
                  }

                  return null;
                })}
              </div>
            )}
          </div>
  );
}
