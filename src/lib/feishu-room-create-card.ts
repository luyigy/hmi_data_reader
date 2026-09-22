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

  // Leave time for the workspace lookup and response within Feishu's 3s callback limit.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      primeFeishuRoomCreationAgents(),
      new Promise<void>((resolve) => { refreshTimer = setTimeout(resolve, 1000); }),
    ]);
  } finally {
    clearTimeout(refreshTimer);
  }
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

export function buildFeishuTaskEntryCard(title: string, requestId: string, state: 'pending' | 'ready' | 'archived' = 'pending') {
  const status = state === 'ready' ? '就绪：在本卡片话题内用 /ap add --agents=local:codex 添加成员，然后持续对话。停止、新会话和加成员均只作用于本任务。'
    : state === 'archived' ? '已归档：不会隐式恢复执行。' : '正在创建：绑定完成前请勿执行任务。';
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: state === 'ready' ? 'green' : 'grey' },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${status}\n请求：${requestId}\n创建失败时在群根会话发送 /ap task retry ${requestId}\n关闭隔离模式不改变已有任务归属。共享目录不提供文件修改隔离。` } }],
  };
}
