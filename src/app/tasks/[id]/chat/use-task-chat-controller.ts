'use client';

import { useTaskChatActions } from './use-task-chat-actions';
import { useTaskChatDerived } from './use-task-chat-derived';
import { useTaskChatSocket } from './use-task-chat-socket';
import { useTaskChatState } from './use-task-chat-state';

export const useTaskChatController = () => {
  const state = useTaskChatState();
  const derived = useTaskChatDerived(state);
  const actions = useTaskChatActions(state, derived);
  useTaskChatSocket(state);
  return { ...state, ...derived, ...actions };
};

export type TaskChatController = ReturnType<typeof useTaskChatController>;
