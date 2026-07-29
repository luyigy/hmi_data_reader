'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { TaskChatController } from './use-task-chat-controller';

const TaskChatContext = createContext<TaskChatController | null>(null);
export const TaskChatProvider = ({ value, children }: { value: TaskChatController; children: ReactNode }) =>
  <TaskChatContext.Provider value={value}>{children}</TaskChatContext.Provider>;
export const useTaskChat = () => {
  const value = useContext(TaskChatContext);
  if (!value) throw new Error('TaskChatProvider is missing');
  return value;
};
