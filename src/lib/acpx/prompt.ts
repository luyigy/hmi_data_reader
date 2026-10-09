import { readContextUsage, contextUsagePercentage } from '@/lib/context-usage';
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

export const withFeishuBotContactInstructions = (message: string) => `${message}\n\nExternal Feishu bot contact (all platform agents):
- When asked to contact an external Feishu/Lark bot (including Tau), automatically use lark-im-mention-bots; do not wait for the user to remind you to load it.
- Read the skill from your installed skill catalog. On Platform Local it is at /home/hello/.agents/skills/lark-im-mention-bots/SKILL.md (also /home/hello/.codex/skills/lark-im-mention-bots/SKILL.md). Remote agents must locate their own installed copy; report a missing skill or CLI instead of claiming delivery.
- Use the sending bot's independent LARKSUITE_CLI_CONFIG_DIR. Verify the actual chat ID and target bot ID, then send with lark-cli im +messages-send --chat-id <chat_id> --text '<at user_id="TARGET_BOT_ID">Bot name</at> message' --as bot.
- Plain @name, platform $member handoffs and private sub-agent messages do not contact external Feishu bots. Keep canonical $member handoffs for actual platform room members.
- Include a unique marker, retain the message_id and read back mentions to verify the target. Establish a readable reply channel before sending; do not interrupt another event connection. Only a matching reply confirms a response; a Typing reaction or successful send does not mean the task completed.
- After a timeout, check existing outputs and running operations before retrying; avoid duplicate execution. This protocol does not authorize unsolicited messages.`;

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

  return withLongFileRuntimeContext(withFeishuBotContactInstructions(`Task: ${request.taskName}

Role: ${participant.role}
Harness: ${participant.harnessType}
Target: ${participant.gatewayName || participant.gatewayId}
Execution Backend: ${participant.executionBackend}

You are being launched from a chat-first task room.
Use the latest task-room instruction as the primary direction for this run.
Treat the task background as stable context, and use the recent transcript to resolve details and intent.${latestInstruction}${taskBackground}${roomTranscript}${priorContext}${warningSection}

Work within your assigned role. If you are not the first participant, build on the previous participant outputs. End with a concise summary and list any modified files.`), longFileContext);
};

const CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD = 60;
const CONTEXT_HARD_EVENT_THRESHOLD = 400;
const CONTEXT_USAGE_ELEVATED_PERCENTAGE = 75;
const CONTEXT_USAGE_HIGH_PERCENTAGE = 85;

export const buildContextWatermarkWarning = ({
  providerUsagePercentage,
  hardReasons,
  metricKind,
  estimatedWindow = false,
  contextStatus = providerUsagePercentage == null ? 'unknown' : 'provider',
}: {
  providerUsagePercentage: number | null;
  hardReasons: string[];
  metricKind?: import('@/lib/harness/types').NormalizedContextUsage['metricKind'];
  estimatedWindow?: boolean;
  contextStatus?: 'provider' | 'unknown' | 'not_applicable';
}): string | null => {
  if (contextStatus === 'not_applicable') return null;
  const usageLabel = metricKind === 'turn_input'
    ? `最近一次模型输入占${estimatedWindow ? '默认估算' : ''}上下文窗口`
    : `当前 session ${estimatedWindow ? '估算' : '最近观测'}上下文占用`;
  if (providerUsagePercentage != null) {
    if (providerUsagePercentage >= CONTEXT_USAGE_HIGH_PERCENTAGE) {
      return [`[系统警告] ${usageLabel}已达 ${providerUsagePercentage}%。`, '请在完成本次任务后立即执行以下操作：', '1. 用 2-3 句话总结你到目前为止完成的工作和关键发现', '2. 告知用户需要通过 /ap new-session 开始新 session 以避免上下文丢失', '不要继续累积新的上下文，先完成当前指令，然后输出总结。'].join('\n');
    }
    return providerUsagePercentage >= CONTEXT_USAGE_ELEVATED_PERCENTAGE
      ? `[系统提示] ${usageLabel}已达 ${providerUsagePercentage}%，建议在合适时机执行 /ap new-session 切换新 session。`
      : null;
  }

  return hardReasons.length > 0
    ? `[系统提示] 当前 session 缺少 provider 上下文遥测；代理信号偏高（${hardReasons.join('、')}），无法确认实际上下文占用。该信号仅供诊断，请检查代理活动与遥测状态。`
    : null;
};

export const checkContextWatermark = async (
  taskId: string,
  taskName: string,
  taskSessionId?: string,
  participant?: Pick<AcpxParticipantRequest, 'executionBackend' | 'harnessType' | 'continuationKey' | 'resumeSessionId' | 'resumeThreadId'>,
  currentParticipantId?: string,
): Promise<string | null> => {
  const hardReasons: string[] = [];
  const sessionId = participant?.resumeSessionId || participant?.resumeThreadId;
  const [roomMessageCount, eventCount, providerParticipant] = await Promise.all([
    countTaskRoomMessages(taskId, taskName),
    prisma.taskRunEvent.count({ where: taskSessionId ? { taskRun: { taskSessionId } } : { taskRun: { taskId } } }),
    participant?.continuationKey && sessionId
      ? prisma.taskRunParticipant.findFirst({
          where: {
            ...(currentParticipantId ? { id: { not: currentParticipantId } } : {}),
            taskRun: taskSessionId ? { taskSessionId } : { taskId },
            executionBackend: participant.executionBackend,
            harnessType: participant.harnessType,
            AND: [
              { controlMetadata: { contains: `"continuationKey":"${participant.continuationKey}"` } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          select: { controlMetadata: true },
        })
      : Promise.resolve(null),
  ]);
  if (roomMessageCount >= CONTEXT_HARD_ROOM_MESSAGE_THRESHOLD) hardReasons.push(`任务室已有 ${roomMessageCount} 条消息`);
  if (eventCount >= CONTEXT_HARD_EVENT_THRESHOLD) hardReasons.push(`已累计 ${eventCount} 条运行事件`);
  const providerUsage = readContextUsage(providerParticipant?.controlMetadata);
  return buildContextWatermarkWarning({
    providerUsagePercentage: providerUsage?.sessionId === sessionId ? contextUsagePercentage(providerUsage) : null,
    hardReasons,
    metricKind: providerUsage?.metricKind,
    estimatedWindow: providerUsage?.isDefaultWindow || !providerUsage?.contextWindow,
    contextStatus: providerUsage
      ? 'provider'
      : 'unknown',
  });
};
