import { ensureTaskChatRoom, postTaskRoomMessage } from '@/lib/task-room';
import {
  completeWorkflowWithCorrections,
  type WorkflowCompletionBaseline,
} from './workflow-completion-gate';

type CorrectionContinuation = {
  resumeSessionId: string;
  resumeThreadId?: string;
  continuationMessage: string;
};

const notifyTaskRoom = async (taskId: string, taskName: string, message: string) => {
  const taskRoom = await ensureTaskChatRoom(taskId, taskName);
  await postTaskRoomMessage({
    roomId: taskRoom.id,
    content: `❌ Workflow completion gate 已停止，未启动替代 Session。\n\n${message}`,
    userId: 'system',
    userName: '系统',
  });
};

export const completeWorkflowInOriginalSession = async ({
  cwd,
  baseline,
  taskId,
  taskName,
  sessionId,
  sessionKind,
  correct,
  notify = (message: string) => notifyTaskRoom(taskId, taskName, message),
}: {
  cwd: string;
  baseline: WorkflowCompletionBaseline;
  taskId: string;
  taskName: string;
  sessionId?: string;
  sessionKind?: string;
  correct: (continuation: CorrectionContinuation) => Promise<void>;
  notify?: (message: string) => Promise<void>;
}) => {
  let validationErrorMessage = '';
  try {
    await completeWorkflowWithCorrections(cwd, baseline, async (validationError, attempt) => {
      validationErrorMessage = validationError.message;
      if (!sessionId) throw new Error('workflow correction failed: original continuation session unavailable');
      await correct({
        resumeSessionId: sessionId,
        resumeThreadId: sessionKind === 'codex_thread' ? sessionId : undefined,
        continuationMessage: [
          `Workflow completion 校验失败（自动纠错 ${attempt}/2）。`,
          `目标 HEAD：${validationError.head}`,
          `失败文档：${validationError.filePaths.join(', ')}`,
          validationError.message,
          '只修订上述相关 PLAN/HANDOVER 并提交；不要执行下一 Slice。提交后立即停止，平台会使用原始 baseline 重新校验。',
        ].join('\n\n'),
      });
    });
  } catch (error) {
    if (!validationErrorMessage) throw error;
    const correctionError = error instanceof Error ? error.message : String(error);
    const message = correctionError.includes(validationErrorMessage)
      ? correctionError
      : `${validationErrorMessage}\n\n${correctionError}`;
    await notify(message);
    throw new Error(message);
  }
};
