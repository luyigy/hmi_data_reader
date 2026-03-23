import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/tasks/[id]/logs
 * 
 * 获取任务执行日志
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;

    // 获取任务信息（包括执行结果）
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignedAgents: {
          include: {
            gateway: true,
          },
        },
        runs: {
          include: {
            participants: true,
            events: {
              orderBy: {
                sequence: 'asc',
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    // 解析执行结果
    let executionLogs: any[] = [];

    if (task.executionMode === 'acpx' && task.runs[0]) {
      const latestRun = task.runs[0];
      executionLogs = latestRun.events.map((event) => {
        const participant = latestRun.participants.find((item) => item.id === event.participantId);
        return {
          timestamp: event.createdAt.toISOString(),
          agentId: participant?.agentId || event.participantId,
          agentName: participant?.agentNameSnapshot || participant?.harnessNameSnapshot || 'ACPX',
          action: event.eventType,
          status:
            event.eventType.includes('failed') || event.stream === 'stderr'
              ? 'error'
              : event.eventType.includes('completed')
              ? 'success'
              : 'info',
          message: event.content,
          details: event.metadata ? JSON.parse(event.metadata) : null,
          duration: undefined,
          sequence: event.sequence,
        };
      });
    } else if (task.result) {
      try {
        const resultData = typeof task.result === 'string'
          ? JSON.parse(task.result)
          : task.result;

        if (resultData.results && Array.isArray(resultData.results)) {
          executionLogs = resultData.results.map((r: any, index: number) => ({
            timestamp: resultData.executedAt || new Date().toISOString(),
            agentId: r.agentId,
            agentName: r.agentName,
            action: 'execute_task',
            status: r.success ? 'success' : 'error',
            message: r.result?.message || r.error || 'Task executed',
            details: r.result,
            duration: r.duration,
            sequence: index,
          }));
        }
      } catch (error) {
        console.error('Failed to parse task result:', error);
      }
    }

    // 构建完整的时间线
    const timeline = [
      {
        timestamp: task.createdAt.toISOString(),
        action: 'task_created',
        status: 'info',
        message: `任务 "${task.name}" 已创建`,
        details: {
          name: task.name,
          description: task.description,
          assignedAgents: task.assignedAgents.map((a) => a.name),
        },
        sequence: 0,
      },
      task.startedAt && {
        timestamp: task.startedAt.toISOString(),
        action: 'task_started',
        status: 'info',
        message: '任务开始执行',
        details: {
          status: task.status,
        },
        sequence: 1,
      },
      ...executionLogs.map((log, i) => ({
        ...log,
        sequence: 2 + i,
      })),
      task.completedAt && {
        timestamp: task.completedAt.toISOString(),
        action: 'task_completed',
        status: task.status === 'completed' ? 'success' : 'error',
        message: task.status === 'completed'
          ? '任务执行完成'
          : `任务执行失败：${task.error || '未知错误'}`,
        details: {
          status: task.status,
          result: task.result,
          error: task.error,
        },
        sequence: 2 + executionLogs.length,
      },
    ].filter(Boolean);

    // 按时间排序
    timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return NextResponse.json({
      taskId: task.id,
      taskName: task.name,
      status: task.status,
      timeline,
      executionLogs,
      metadata: {
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString(),
        completedAt: task.completedAt?.toISOString(),
        executionMode: task.executionMode,
        runnerTarget: task.runnerTarget,
        acpxParticipants: (() => {
          try {
            return JSON.parse(task.acpxParticipants || '[]');
          } catch {
            return [];
          }
        })(),
        workingDirectory: task.workingDirectory,
        assignedAgents: task.assignedAgents.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          gateway: a.gateway
            ? {
                id: a.gateway.id,
                name: a.gateway.name,
              }
            : null,
        })),
      },
    });
  } catch (error) {
    console.error('Failed to fetch task logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch task logs' },
      { status: 500 }
    );
  }
}
