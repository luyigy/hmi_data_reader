import { prisma } from '../prisma';
import type { syncLiveRoomSourceTask } from '../live-room-members';

type SourceTask = NonNullable<Awaited<ReturnType<typeof syncLiveRoomSourceTask>>>;

export async function prepareGraphConversationTask(source: SourceTask): Promise<SourceTask> {
  const parent = await prisma.taskGraphRun.findFirst({ where: { parentTaskId: source.id }, orderBy: { version: 'desc' } });
  return parent ? { ...source, description: `${source.description || ''}\n任务路线对话由你结合完整上下文理解。用户明确要求恢复特定任务时可输出 <graph-control>{"action":"resume_task","nodeKey":"实际节点键"}</graph-control>，平台核验原消息身份、权限和任务归属。提问或状态描述不产生恢复动作。` } : source;
}
