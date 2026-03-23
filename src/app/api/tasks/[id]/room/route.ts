import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureTaskChatRoom } from '@/lib/task-room';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const task = await prisma.task.findUnique({
      where: { id: params.id },
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
