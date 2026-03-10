import { prisma } from '@/lib/prisma';

export const defaultRooms = [
  { id: 'general', name: '大厅', description: '全员沟通' },
  { id: 'tasks', name: '任务协作', description: '任务编排与状态' },
  { id: 'agents', name: 'Agent 协作', description: '多 Agent 讨论' },
];

export async function ensureDefaultRooms() {
  const count = await prisma.chatRoom.count();
  if (count > 0) return;

  await prisma.chatRoom.createMany({
    data: defaultRooms.map((room) => ({
      id: room.id,
      name: room.name,
      description: room.description,
    })),
  });
}
