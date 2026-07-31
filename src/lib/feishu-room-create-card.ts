import { prisma } from '@/lib/prisma';
import { listLiveRoomCatalogAgents } from '@/lib/live-room';
import { buildFeishuRoomCreationCard } from '@/lib/feishu-help';

export async function openFeishuRoomCreationCard(args: {
  openId?: string;
  chatId?: string;
  chatType: 'p2p' | 'group';
}) {
  if (!args.openId || !args.chatId) {
    return { toast: { type: 'warning', content: '房间创建卡已失效，请重新发送 /ap menu' } };
  }

  const [agents, access] = await Promise.all([
    listLiveRoomCatalogAgents(),
    prisma.feishuUserAccess.findUnique({
      where: { openId: args.openId },
      select: { workspaceRoot: true },
    }),
  ]);
  if (!agents.length) {
    return { toast: { type: 'warning', content: '当前没有可选 Agent，请先检查网关和 Agent 状态' } };
  }

  return {
    toast: { type: 'success', content: '房间配置表单已打开' },
    card: {
      type: 'raw',
      data: buildFeishuRoomCreationCard(
        args.chatType,
        agents.map((agent) => ({
          id: agent.id,
          label: [
            agent.userNickname || agent.agentName || agent.label,
            agent.hostname || agent.gatewayName,
            agent.status,
          ].filter(Boolean).join(' · '),
        })),
        access?.workspaceRoot,
      ),
    },
  };
}
