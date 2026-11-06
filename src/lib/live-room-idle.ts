import { prisma } from '@/lib/prisma';

// Task completion precedes reply relay and asynchronous handoff enqueue.
export async function isLiveRoomBusy(taskId: string, roomId: string): Promise<boolean> {
  const [runs, deliveries] = await Promise.all([
    prisma.taskRun.count({
      where: { taskId, status: { in: ['pending', 'running', 'waiting_for_input'] } },
    }),
    prisma.liveRoomDelivery.count({
      where: {
        roomMessage: { roomId },
        deliveryStatus: { in: ['pending', 'running'] },
      },
    }),
  ]);
  return runs > 0 || deliveries > 0;
}

export const SESSION_ROTATION_WAITING = '等待当前任务、回复及交接结束后自动换代。';
