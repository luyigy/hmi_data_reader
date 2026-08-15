import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { clearTaskRoomMessages } from '@/lib/task-room';
import { ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

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
    const user = await requireCurrentUser(request);
    const liveRoom = await prisma.liveRoom.findFirst({
      where: { id: params.id, ...ownedByCurrentUser(user) },
      select: {
        id: true,
        title: true,
        sourceTaskId: true,
      },
    });

    if (!liveRoom) {
      return NextResponse.json({ error: 'Live room not found' }, { status: 404 });
    }

    if (!liveRoom.sourceTaskId) {
      return NextResponse.json(
        { error: 'Live room is not associated with a task' },
        { status: 400 }
      );
    }

    const result = await clearTaskRoomMessages(liveRoom.sourceTaskId, liveRoom.title);

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
      taskId: liveRoom.sourceTaskId,
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
