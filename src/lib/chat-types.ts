export type ChatUser = {
  id: string;
  name: string;
};

export type ChatMessageTargetType = 'task' | 'participant' | 'all';

export type ChatMessageTarget = {
  type: ChatMessageTargetType;
  participantKey?: string | null;
  participantLabel?: string | null;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  user: ChatUser;
  content: string;
  target: ChatMessageTarget;
  createdAt: string;
};

export type ChatRoom = {
  id: string;
  name: string;
  description?: string;
};
