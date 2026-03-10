'use client';

import { useMemo, useState } from 'react';
import type { AgentRef } from '@/lib/mentions';

export default function ChatInput({
  onSend,
  placeholder,
  agents,
}: {
  onSend: (content: string) => void;
  placeholder?: string;
  agents: AgentRef[];
}) {
  const [value, setValue] = useState('');
  const [showMentions, setShowMentions] = useState(false);

  const mentionQuery = useMemo(() => {
    const match = value.match(/@([\w\u4e00-\u9fa5-]*)$/);
    return match?.[1] ?? '';
  }, [value]);

  const mentionCandidates = useMemo(() => {
    if (!showMentions) return [];
    const query = mentionQuery.toLowerCase();
    return agents
      .filter((agent) => agent.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [agents, mentionQuery, showMentions]);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    console.log('[ChatInput] Sending message:', trimmed);
    onSend(trimmed);
    console.log('[ChatInput] onSend called');
    setValue('');
    setShowMentions(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handlePickMention = (name: string) => {
    const next = value.replace(/@([\w\u4e00-\u9fa5-]*)$/, `@${name} `);
    setValue(next);
    setShowMentions(false);
  };

  const handleBlur = () => {
    // 延迟隐藏，避免点击按钮时先触发 blur
    setTimeout(() => setShowMentions(false), 200);
  };

  // 检查是否正在输入@提及（@在文本末尾）
  const isTypingMention = (text: string): boolean => {
    const match = text.match(/@([\w\u4e00-\u9fa5-]*)$/);
    return !!match;
  };

  return (
    <div className="relative">
      {showMentions && mentionCandidates.length > 0 && (
        <div className="absolute bottom-16 left-4 z-10 w-64 rounded-lg border border-gray-200 bg-white shadow-lg">
          {mentionCandidates.map((agent) => (
            <button
              key={agent.id ?? agent.name}
              onClick={() => handlePickMention(agent.name)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              type="button"
              onMouseDown={(e) => e.preventDefault()} // 防止触发 textarea blur
            >
              <span className="h-2 w-2 rounded-full bg-indigo-500" />
              <span>{agent.name}</span>
              {agent.location && (
                <span className="text-xs text-gray-400">{agent.location}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-3 border-t border-gray-200 bg-white px-4 py-3">
        <textarea
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            // 只在正在输入@提及时显示下拉框（@在末尾）
            if (isTypingMention(next)) {
              setShowMentions(true);
            } else {
              setShowMentions(false);
            }
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || '输入消息，使用 @agent-name 提及'}
          rows={2}
          className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
        />
        <button
          onClick={handleSend}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          type="button"
        >
          发送
        </button>
      </div>
    </div>
  );
}
