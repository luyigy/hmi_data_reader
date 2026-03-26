import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { clearTaskRoomMessages } from '@/lib/task-room';

/**
 * POST /api/live-rooms/[id]/clear-task-room
 * 清空 Live Room 关联的 Task Room 历史消息
 * 用于清理无关的历史上下文，确保 agent 只收到当前任务相关的消息
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const liveRoom = await prisma.liveRoom.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        taskId: true,
        taskName: true,
      },
    });

    if (!liveRoom) {
      return NextResponse.json({ error: 'Live room not found' }, { status: 404 });
    }

    if (!liveRoom.taskId) {
      return NextResponse.json(
        { error: 'Live room is not associated with a task' },
        { status: 400 }
      );
    }

    const result = await clearTaskRoomMessages(liveRoom.taskId, liveRoom.taskName || liveRoom.name);

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: result.message,
      liveRoomId: liveRoom.id,
      taskId: liveRoom.taskId,
      taskRoomId: result.roomId,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Failed to clear live room task messages:', error);
    return NextResponse.json(
      { error: 'Failed to clear live room task messages' },
      { status: 500 }
    );
  }
}
