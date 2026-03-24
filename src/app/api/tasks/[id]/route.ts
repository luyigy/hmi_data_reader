import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { reconcileTaskRunLiveness } from '@/lib/acpx/liveness';
import type { Prisma } from '@prisma/client';
import type { AcpxParticipantRequest, AcpxPermissionConfig } from '@/lib/acpx/types';
import { DEFAULT_ACPX_PERMISSION_CONFIG, normalizeAcpxPermissionConfig } from '@/lib/acpx/permissions';

const parseJson = <T,>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

type TaskWithRelations = Prisma.TaskGetPayload<{
  include: {
    currentTaskSession: true;
    assignedAgents: {
      include: {
        gateway: true;
      };
    };
  };
}>;

const formatTask = (task: TaskWithRelations) => ({
  ...task,
  result: parseJson(task.result, null),
  acpxParticipants: parseJson<AcpxParticipantRequest[]>(task.acpxParticipants, []),
  acpxPermissionConfig: parseJson<AcpxPermissionConfig>(
    task.acpxPermissionConfig,
    DEFAULT_ACPX_PERMISSION_CONFIG
  ),
  currentTaskSession: task.currentTaskSession
    ? {
        ...task.currentTaskSession,
        metadata: parseJson(task.currentTaskSession.metadata, null),
      }
    : null,
  assignedAgents: task.assignedAgents.map((agent) => ({
    ...agent,
    gateway: agent.gateway
      ? {
          id: agent.gateway.id,
          name: agent.gateway.name,
        }
      : null,
    capabilities: parseJson(agent.capabilities, []),
  })),
});

// GET /api/tasks/[id] - 获取单个任务
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await reconcileTaskRunLiveness(params.id);

    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: {
        currentTaskSession: true,
        assignedAgents: {
          include: {
            gateway: true,
          },
        },
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(formatTask(task));
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
    const { status, result, error, acpxParticipants, acpxPermissionConfig } = body;

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

    const updateData: Prisma.TaskUpdateInput = {};

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

    if (acpxParticipants !== undefined) {
      updateData.acpxParticipants = JSON.stringify(acpxParticipants);
    }

    if (acpxPermissionConfig !== undefined) {
      updateData.acpxPermissionConfig = JSON.stringify(
        normalizeAcpxPermissionConfig(acpxPermissionConfig)
      );
    }

    const updated = await prisma.task.update({
      where: { id: params.id },
      data: updateData,
      include: {
        currentTaskSession: true,
        assignedAgents: {
          include: {
            gateway: true,
          },
        },
      },
    });

    return NextResponse.json(formatTask(updated));
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
