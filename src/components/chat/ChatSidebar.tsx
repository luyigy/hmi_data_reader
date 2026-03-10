import type { ChatRoom, ChatUser } from '@/lib/chat-types';

export default function ChatSidebar({
  rooms,
  currentRoomId,
  onSelectRoom,
  users,
}: {
  rooms: ChatRoom[];
  currentRoomId: string;
  onSelectRoom: (roomId: string) => void;
  users: ChatUser[];
}) {
  return (
    <aside className="w-full rounded-lg border border-gray-100 bg-white p-4 shadow-sm">
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-gray-700">聊天房间</h3>
        <div className="mt-3 flex flex-col gap-2">
          {rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => onSelectRoom(room.id)}
              className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                currentRoomId === room.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              type="button"
            >
              <div className="font-medium">{room.name}</div>
              {room.description && (
                <div className="text-xs text-gray-500">{room.description}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-700">在线用户</h3>
        <div className="mt-3 flex flex-col gap-2">
          {users.length === 0 && (
            <span className="text-xs text-gray-400">暂无在线用户</span>
          )}
          {users.map((user) => (
            <div key={user.id} className="flex items-center gap-2 text-sm">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-gray-700">{user.name}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
