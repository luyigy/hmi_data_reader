'use client';

import { useState } from 'react';
import type { ConversationFeedItem } from './task-chat-types';

interface CollapsibleExecutionBlockProps {
  items: ConversationFeedItem[];
  /** Number of summary-level items to always show before the fold */
  summaryCount: number;
}

export function CollapsibleExecutionBlock({ items, summaryCount }: CollapsibleExecutionBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) return null;

  const detailItems = items.filter(
    (item) => item.runEvent?.tier === 'detail'
  );
  const toolCallCount = detailItems.length;
  const hasDetail = toolCallCount > 0;

  // Summary items: eventType is not stdout_chunk/stderr_chunk
  const summaryItems = items.filter(
    (item) => !item.runEvent || item.runEvent.tier !== 'detail'
  );

  // Items to show in the collapsed header area (first N summary items)
  const headerSummaryItems = summaryItems.slice(0, Math.max(1, summaryCount));
  const remainingSummaryItems = summaryItems.slice(headerSummaryItems.length);

  if (!hasDetail && summaryItems.length <= 1) {
    // If there's only summary and no detail, render inline (no fold)
    return (
      <>
        {summaryItems.map((item) => (
          <RunEventItem key={item.id} item={item} />
        ))}
      </>
    );
  }

  return (
    <div className="rounded-[18px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* Header — always visible */}
      {headerSummaryItems.map((item) => (
        <RunEventItem key={item.id} item={item} compact />
      ))}

      {/* Detail fold bar */}
      {hasDetail && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2 text-left text-[12px] text-slate-500 transition-colors hover:bg-slate-50"
        >
          <span className="text-[14px]">{expanded ? '▼' : '▶'}</span>
          <span>
            详细执行过程 ({toolCallCount} 个步骤{toolCallCount !== detailItems.length ? ` / ${detailItems.length} 次工具调用` : ''})
          </span>
          <span className="ml-auto text-[11px] text-slate-400">
            {expanded ? '点击收起' : '点击展开'}
          </span>
        </button>
      )}

      {/* Expanded detail content */}
      {expanded && hasDetail && (
        <div className="border-t border-slate-100 bg-slate-50/50 px-3 py-2">
          {detailItems.map((item) => (
            <RunEventItem key={item.id} item={item} compact nested />
          ))}
        </div>
      )}

      {/* Remaining summary items after fold */}
      {remainingSummaryItems.map((item) => (
        <RunEventItem key={item.id} item={item} />
      ))}
    </div>
  );
}

/** Renders a single run event inline */
function RunEventItem({
  item,
  compact = false,
  nested = false,
}: {
  item: ConversationFeedItem;
  compact?: boolean;
  nested?: boolean;
}) {
  const event = item.runEvent;
  if (!event) return null;

  const isAssistantReply =
    event.eventType === 'stdout_chunk'
    && event.stream === 'stdout'
    && !!event.participant
    && event.participant.executionBackend === 'platform_local';
  const isSystemEvent =
    event.eventType === 'session_continuation_started'
    || event.eventType === 'control_message';

  if (event.eventType === 'session_continuation_started') {
    return (
      <div className="mx-auto max-w-2xl px-3 py-2">
        <div className="rounded-full border border-sky-200 bg-sky-50 px-4 py-1.5 text-center text-xs text-sky-800 shadow-sm">
          {event.content}
        </div>
      </div>
    );
  }

  if (isAssistantReply) {
    const pad = nested ? 'px-2 py-1.5' : compact ? 'px-3 py-2' : 'px-4 py-3';
    return (
      <div className={`${pad} ${nested ? 'text-slate-700' : 'text-slate-900'} ${nested ? '' : 'bg-white'}`}>
        {!compact && (
          <div className="mb-1 text-[11px] text-slate-500">
            {event.participant?.role || 'assistant'} · {new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}
          </div>
        )}
        <div className={`whitespace-pre-wrap break-words ${nested ? 'text-[11px] leading-5' : 'text-[13px] leading-6'}`}>
          {event.content}
        </div>
      </div>
    );
  }

  const eventToneClass = isSystemEvent
    ? 'border-amber-200 bg-amber-50/80'
    : 'border-slate-200/80 bg-white/88';
  const pad = nested ? 'px-2 py-1' : compact ? 'px-3 py-1.5' : 'px-3.5 py-2.5';

  return (
    <div className={`${pad} ${nested ? '' : eventToneClass} ${nested ? '' : 'rounded-[18px] border shadow-sm'}`}>
      {!compact && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
          <span>{new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{event.eventType}</span>
          {event.participant ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
              {event.participant.role} · {event.participant.executionBackend === 'platform_local' ? 'Platform Local' : event.participant.gatewayName} / {event.participant.harnessType}
            </span>
          ) : null}
        </div>
      )}
      <pre className={`whitespace-pre-wrap break-words font-mono ${nested ? 'text-[10px] leading-4' : 'text-[11px] leading-5'} ${event.stream === 'stderr' ? 'text-red-600' : 'text-slate-800'}`}>
        {event.content}
      </pre>
    </div>
  );
}
