import type { ChatMessage as ChatMessageType } from '@/lib/chat-types';

const highlightMentions = (content: string) => {
  const parts = content.split(/(@[a-zA-Z0-9_-]+)/g);
  return parts.map((part, index) => {
    if (part.startsWith('@')) {
      return (
        <span key={index} className="text-indigo-600 font-medium">
          {part}
        </span>
      );
    }
    return <span key={index}>{part}</span>;
  });
};

export default function ChatMessage({
  message,
  isOwn,
}: {
  message: ChatMessageType;
  isOwn?: boolean;
}) {
  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`flex max-w-[75%] flex-col gap-1 rounded-lg px-4 py-3 shadow-sm ${
          isOwn
            ? 'bg-indigo-600 text-white'
            : 'border border-gray-100 bg-white text-gray-800'
        }`}
      >
        <div className={`flex items-center justify-between text-xs ${isOwn ? 'text-indigo-100' : 'text-gray-500'}`}>
          <span className="font-medium">{message.user.name}</span>
          <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
        </div>
        <div className={`text-sm leading-relaxed ${isOwn ? 'text-white' : 'text-gray-800'}`}>
          {highlightMentions(message.content)}
        </div>
      </div>
    </div>
  );
}
