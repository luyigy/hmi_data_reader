import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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
        mode: run.mode,
        orchestrationMode: run.orchestrationMode,
        status: run.status,
        summary: run.summary,
        error: run.error,
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
