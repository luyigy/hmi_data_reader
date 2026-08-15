import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureTaskChatRoom, clearTaskRoomMessages } from '@/lib/task-room';
import { ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await requireCurrentUser(request);
    const task = await prisma.task.findFirst({
      where: { id: params.id, ...ownedByCurrentUser(user) },
      select: {
        id: true,
        name: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const room = await ensureTaskChatRoom(task.id, task.name);

    return NextResponse.json({
      taskId: task.id,
      room: {
        id: room.id,
        name: room.name,
        description: room.description,
      },
    });
  } catch (error) {
    console.error('Failed to fetch task room:', error);
    return NextResponse.json(
      { error: 'Failed to fetch task room' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/tasks/[id]/room
 * 清空 Task Room 的所有历史消息
 * 用于清理无关的历史上下文
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await requireCurrentUser(request);
    const task = await prisma.task.findFirst({
      where: { id: params.id, ...ownedByCurrentUser(user) },
      select: {
        id: true,
        name: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const result = await clearTaskRoomMessages(task.id, task.name);

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: result.message,
      roomId: result.roomId,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Failed to clear task room messages:', error);
    return NextResponse.json(
      { error: 'Failed to clear task room messages' },
      { status: 500 }
    );
  }
}
