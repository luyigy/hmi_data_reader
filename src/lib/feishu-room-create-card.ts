import { prisma } from '@/lib/prisma';
import { listLiveRoomCatalogAgents } from '@/lib/live-room';
import {
  buildFeishuRoomCreationCard,
  type FeishuRoomCreationAgent,
} from '@/lib/feishu-help';

let cachedAgents: FeishuRoomCreationAgent[] | null = null;
let refreshPromise: Promise<void> | null = null;

export function primeFeishuRoomCreationAgents() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = listLiveRoomCatalogAgents()
    .then((agents) => {
      cachedAgents = agents.map((agent) => ({
        id: agent.id,
        label: [
          agent.userNickname || agent.agentName || agent.label,
          agent.hostname || agent.gatewayName,
          agent.status,
        ].filter(Boolean).join(' · '),
      }));
    })
    .catch((error) => {
      console.error('[FeishuRuntime] room creation agent preload failed', error);
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export async function openFeishuRoomCreationCard(args: {
  openId?: string;
  chatId?: string;
  chatType: 'p2p' | 'group';
}) {
  if (!args.openId || !args.chatId) {
    return { toast: { type: 'warning', content: '房间创建卡已失效，请重新发送 /ap menu' } };
  }

  await primeFeishuRoomCreationAgents();
  if (!cachedAgents) {
    return { toast: { type: 'warning', content: 'Agent 列表正在加载，请稍后重试' } };
  }
  if (!cachedAgents.length) {
    return { toast: { type: 'warning', content: '当前没有可选 Agent，请先检查网关和 Agent 状态' } };
  }
  const access = await prisma.feishuUserAccess.findUnique({
    where: { openId: args.openId },
    select: { workspaceRoot: true },
  });

  return {
    toast: { type: 'success', content: '房间配置表单已打开' },
    card: {
      type: 'raw',
      data: buildFeishuRoomCreationCard(
        args.chatType,
        cachedAgents,
        access?.workspaceRoot,
      ),
    },
  };
}
