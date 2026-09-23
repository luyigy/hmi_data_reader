import { resolveFeishuMessageTarget, sendFeishuTextMessage } from '@/lib/feishu-api';
import { prisma } from '@/lib/prisma';
import { resolveFeishuConversationTarget } from '@/lib/feishu-live-room';

export type FeishuSessionContinuityArgs = {
  context: {
    chatId: string;
    chatType: string;
    senderOpenId: string;
    messageId: string;
    mentionNames?: string[];
    threadId?: string;
    rootId?: string;
    parentMessageId?: string;
  };
  replyId?: string;
};

type FeishuBindingRow = {
  liveRoomId: string;
  threadId: string | null;
  rootMessageId: string | null;
};

type ExpiredSessionRow = {
  memberId: string;
  memberName: string;
  lastError: string | null;
};

const buildWarningText = (sessions: ExpiredSessionRow[]) => {
  const affectedMembers = Array.from(
    new Set(
      sessions
        .map((session) => session.memberName.trim())
        .filter(Boolean)
    )
  );
  const memberLabel =
    affectedMembers.length === 0
      ? '部分 agent'
      : affectedMembers.slice(0, 3).join('、') + (affectedMembers.length > 3 ? ' 等 agent' : '');

  return `系统提示：检测到 ${memberLabel} 的续聊会话已失效；本轮会自动改为新会话继续，历史上下文可能不完整。`;
};

export async function maybeSendFeishuSessionWatermarkWarning({
  context,
  replyId,
}: FeishuSessionContinuityArgs) {
  // Resolve through the shared target so a task topic never reports the group
  // room's sessions; unknown or archived topics carry no room to warn about.
  const target = await resolveFeishuConversationTarget(context);
  if (target.kind !== 'group_entry' && target.kind !== 'task') {
    return false;
  }
  const binding: FeishuBindingRow | null = target.binding
    ? { liveRoomId: target.binding.liveRoomId, threadId: target.binding.threadId, rootMessageId: target.binding.rootMessageId }
    : null;

  if (!binding) {
    return false;
  }

  const expiredSessions = await prisma.$queryRaw<ExpiredSessionRow[]>`
    SELECT
      session."memberId" AS "memberId",
      member."displayName" AS "memberName",
      session."lastError" AS "lastError"
    FROM "LiveRoomMemberSession" session
    INNER JOIN "LiveRoomMember" member
      ON member."id" = session."memberId"
    WHERE session."roomId" = ${binding.liveRoomId}
      AND session."status" = 'expired'
    ORDER BY session."updatedAt" DESC
    LIMIT 5
  `;

  if (expiredSessions.length === 0) {
    return false;
  }

  await sendFeishuTextMessage({
    ...resolveFeishuMessageTarget({ ...binding, chatId: context.chatId }),
    replyId,
    text: buildWarningText(expiredSessions),
  });

  return true;
}
