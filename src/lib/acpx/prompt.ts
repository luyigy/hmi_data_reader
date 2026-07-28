import { prisma } from '@/lib/prisma';
import { countTaskRoomMessages } from '@/lib/task-room';
import { longFileRuntimeNotice, type LongFileRuntimeContext } from './long-file-runtime-context';
import type { AcpxParticipantRequest, AcpxRunRequest } from './types';

type TaskRoomPromptContext = {
  transcript: string;
  latestUserMessage: {
    id: string;
    content: string;
    createdAt: string;
    targetType: string;
    targetParticipantLabel: string | null;
  } | null;
};

const stripLeadingMention = (content: string): string => {
  if (!content.startsWith('@')) return content;
  const greedyMatch = content.match(/^@.+\s+([\s\S]+)$/);
  const nonGreedyMatch = content.match(/^@\S+\s+([\s\S]*)$/);
  const stripped = greedyMatch?.[1].trim() || nonGreedyMatch?.[1].trim() || content;
  if (process.env.DEBUG_MENTION_DETECTION === 'true' && stripped !== content) {
    console.log('[buildHarnessPrompt] Double-insurance stripping @mention:', { original: content, stripped });
  }
  return stripped;
};

export const withLongFileRuntimeContext = (message: string, context?: LongFileRuntimeContext | null) =>
  context?.offenders.length
    ? [
        longFileRuntimeNotice(context),
        'Historical over-limit files must not grow during this run. Do not add a new file at or above the threshold.',
        message,
      ].join('\n\n')
    : message;

export const buildHarnessPrompt = (
  request: AcpxRunRequest,
  participant: AcpxParticipantRequest,
  previousSummaries: string[],
  taskRoomContext: TaskRoomPromptContext,
  contextWarning?: string | null,
  longFileContext?: LongFileRuntimeContext | null,
) => {
  const latestInstructionContent = taskRoomContext.latestUserMessage
    ? stripLeadingMention(taskRoomContext.latestUserMessage.content)
    : '';
  const latestInstruction = latestInstructionContent
    ? `\n\nLatest task-room instruction (highest priority for this run):\n${latestInstructionContent}`
    : '';
  const taskBackground = request.taskDescription ? `\n\nTask background:\n${request.taskDescription}` : '';
  const roomTranscript = taskRoomContext.transcript ? `\n\nRecent task-room transcript:\n${taskRoomContext.transcript}` : '';
  const priorContext = previousSummaries.length > 0
    ? `\n\nPrevious participant outputs:\n${previousSummaries.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
    : '';
  const warningSection = contextWarning ? `\n\n${contextWarning}` : '';

  return withLongFileRuntimeContext(`Task: ${request.taskName}

Role: ${participant.role}
Harness: ${participant.harnessType}
Target: ${participant.gatewayName || participant.gatewayId}
Execution Backend: ${participant.executionBackend}

You are being launched from a chat-first task room.
Use the latest task-room instruction as the primary direction for this run.
Treat the task background as stable context, and use the recent transcript to resolve details and intent.${latestInstruction}${taskBackground}${roomTranscript}${priorContext}${warningSection}

Work within your assigned role. If you are not the first participant, build on the previous participant outputs. End with a concise summary and list any modified files.`, longFileContext);
};

const CONTEXT_WARN_ROOM_MESSAGE_THRESHOLD = 40;
const CONTEXT_WARN_EVENT_THRESHOLD = 200;
const CONTEXT_WARN_TRANSCRIPT_NEAR_LIMIT = 3800;
const CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD = 60;
const CONTEXT_HARD_EVENT_THRESHOLD = 400;

export const checkContextWatermark = async (
  taskId: string,
  taskName: string,
  taskRoomContext: Pick<TaskRoomPromptContext, 'transcript'>,
  taskSessionId?: string,
): Promise<string | null> => {
  const softReasons: string[] = [];
  const hardReasons: string[] = [];
  if (taskRoomContext.transcript.length >= CONTEXT_WARN_TRANSCRIPT_NEAR_LIMIT) softReasons.push('对话记录已满');
  const [roomMessageCount, eventCount] = await Promise.all([
    countTaskRoomMessages(taskId, taskName),
    prisma.taskRunEvent.count({ where: taskSessionId ? { taskRun: { taskSessionId } } : { taskRun: { taskId } } }),
  ]);
  if (roomMessageCount >= CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD) hardReasons.push(`任务室已有 ${roomMessageCount} 条消息`);
  else if (roomMessageCount >= CONTEXT_WARN_ROOM_MESSAGE_THRESHOLD) softReasons.push(`任务室已有 ${roomMessageCount} 条消息`);
  if (eventCount >= CONTEXT_HARD_EVENT_THRESHOLD) hardReasons.push(`已累计 ${eventCount} 条运行事件`);
  else if (eventCount >= CONTEXT_WARN_EVENT_THRESHOLD) softReasons.push(`已累计 ${eventCount} 条运行事件`);
  if (hardReasons.length > 0) return [`[系统警告] 当前 session 上下文已严重超载（${hardReasons.join('、')}）。`, '请在完成本次任务后立即执行以下操作：', '1. 用 2-3 句话总结你到目前为止完成的工作和关键发现', '2. 告知用户需要通过 /ap new-session 开始新 session 以避免上下文丢失', '不要继续累积新的上下文，先完成当前指令，然后输出总结。'].join('\n');
  return softReasons.length > 0 ? `[系统提示] 当前 session 上下文已接近阈值（${softReasons.join('、')}），建议在合适时机执行 /ap new-session 切换新 session。` : null;
};
