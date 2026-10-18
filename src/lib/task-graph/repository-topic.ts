import { prisma } from '../prisma';

/** Repository registration chooses the destination; task worktree names never do. */
export async function graphTopicDestination(parentTaskId: string, repository?: string) {
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (repository) {
    const bindings = await prisma.feishuConversationBinding.findMany({ where: {
      chatType: 'group', liveRoom: { workingDirectory: repository, status: 'active' },
      ...(appId ? { OR: [{ appId }, { appId: null }] } : { appId: { not: null } }),
    }, orderBy: { updatedAt: 'desc' } });
    const registrations = bindings.filter(binding => !binding.rootMessageId && !binding.threadId);
    const destinations = new Map<string, { appId: string; chatId: string }>();
    for (const binding of registrations.length ? registrations : bindings) {
      const identity = binding.appId || appId;
      if (identity) destinations.set(JSON.stringify([identity, binding.chatId]), { appId: identity, chatId: binding.chatId });
    }
    if (destinations.size > 1) throw new Error(`仓库绑定了多个飞书群，需明确任务目标群：${repository}`);
    const destination = destinations.values().next().value;
    if (destination) return destination;
  }
  const parent = await prisma.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: parentTaskId }, chatType: 'group', appId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  return parent?.appId ? { appId: parent.appId, chatId: parent.chatId } : null;
}
