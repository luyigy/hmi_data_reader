import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// GET /api/tasks/[id] - 获取单个任务
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: {
        assignedAgents: true,
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    const formatted = {
      ...task,
      result: task.result ? JSON.parse(task.result) : null,
      assignedAgents: task.assignedAgents.map((agent) => ({
        ...agent,
        capabilities: (() => {
          try {
            return JSON.parse(agent.capabilities || '[]');
          } catch {
            return [];
          }
        })(),
      })),
    };

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch task:', error);
    return NextResponse.json(
      { error: 'Failed to fetch task' },
      { status: 500 }
    );
  }
}

// PUT /api/tasks/[id] - 更新任务状态
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { status, result, error } = body;

    // 验证状态
    const validStatuses = ['pending', 'running', 'completed', 'failed'];
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }

    const task = await prisma.task.findUnique({
      where: { id: params.id },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    const updateData: any = {};
    
    if (status) {
      updateData.status = status;
      
      // 自动设置时间戳
      if (status === 'running' && !task.startedAt) {
        updateData.startedAt = new Date();
      }
      if ((status === 'completed' || status === 'failed') && !task.completedAt) {
        updateData.completedAt = new Date();
      }
    }
    
    if (result !== undefined) {
      updateData.result = typeof result === 'string' ? result : JSON.stringify(result);
    }
    
    if (error !== undefined) {
      updateData.error = error;
    }

    const updated = await prisma.task.update({
      where: { id: params.id },
      data: updateData,
      include: {
        assignedAgents: true,
      },
    });

    const formatted = {
      ...updated,
      result: updated.result ? JSON.parse(updated.result) : null,
      assignedAgents: updated.assignedAgents.map((agent) => ({
        ...agent,
        capabilities: (() => {
          try {
            return JSON.parse(agent.capabilities || '[]');
          } catch {
            return [];
          }
        })(),
      })),
    };

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to update task:', error);
    return NextResponse.json(
      { error: 'Failed to update task' },
      { status: 500 }
    );
  }
}

// DELETE /api/tasks/[id] - 删除任务
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const task = await prisma.task.findUnique({
      where: { id: params.id },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    await prisma.task.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: 'Task deleted' });
  } catch (error) {
    console.error('Failed to delete task:', error);
    return NextResponse.json(
      { error: 'Failed to delete task' },
      { status: 500 }
    );
  }
}
