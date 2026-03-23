import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: {
        runs: {
          include: {
            participants: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({
      taskId: task.id,
      executionMode: task.executionMode,
      runs: task.runs.map((run) => ({
        id: run.id,
        taskSessionId: run.taskSessionId,
        mode: run.mode,
        orchestrationMode: run.orchestrationMode,
        status: run.status,
        controlState: run.controlState,
        activityState: run.activityState,
        summary: run.summary,
        error: run.error,
        watchdogConfig: run.watchdogConfig ? JSON.parse(run.watchdogConfig) : null,
        lastActivityAt: run.lastActivityAt?.toISOString() ?? null,
        lastStdoutAt: run.lastStdoutAt?.toISOString() ?? null,
        lastStderrAt: run.lastStderrAt?.toISOString() ?? null,
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        createdAt: run.createdAt.toISOString(),
        participants: run.participants.map((participant) => ({
          id: participant.id,
          gatewayId: participant.gatewayId,
          gatewayName: participant.gatewayNameSnapshot,
          executionBackend: participant.executionBackend,
          harnessType: participant.harnessType,
          role: participant.role,
          status: participant.status,
          activityState: participant.activityState,
          lastActivityAt: participant.lastActivityAt?.toISOString() ?? null,
          interruptSupported: participant.interruptSupported,
          resumeSupported: participant.resumeSupported,
          sessionControlSupported: participant.sessionControlSupported,
          softStopSupported: participant.softStopSupported,
        })),
      })),
    });
  } catch (error) {
    console.error('Failed to fetch task runs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch task runs' },
      { status: 500 }
    );
  }
}
