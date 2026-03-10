export type ChatUser = {
  id: string;
  name: string;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  user: ChatUser;
  content: string;
  createdAt: string;
};

export type ChatRoom = {
  id: string;
  name: string;
  description?: string;
};
