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
            events: {
              include: {
                participant: true,
              },
              orderBy: { sequence: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const latestRun = task.runs[0] ?? null;

    return NextResponse.json({
      taskId: task.id,
      executionMode: task.executionMode,
      latestRun: latestRun
        ? {
            id: latestRun.id,
            mode: latestRun.mode,
            orchestrationMode: latestRun.orchestrationMode,
            status: latestRun.status,
            summary: latestRun.summary,
            error: latestRun.error,
            startedAt: latestRun.startedAt?.toISOString() ?? null,
            completedAt: latestRun.completedAt?.toISOString() ?? null,
            participants: latestRun.participants.map((participant) => ({
              id: participant.id,
              gatewayId: participant.gatewayId,
              gatewayName: participant.gatewayNameSnapshot,
              executionBackend: participant.executionBackend as 'platform_local' | 'gateway_openclaw',
              harnessType: participant.harnessType,
              harnessLabel: participant.harnessNameSnapshot,
              role: participant.role,
              agentId: participant.agentId,
              agentName: participant.agentNameSnapshot,
              status: participant.status,
              summary: participant.summary,
              error: participant.error,
              filesModified: participant.filesModified ? JSON.parse(participant.filesModified) : [],
              startedAt: participant.startedAt?.toISOString() ?? null,
              completedAt: participant.completedAt?.toISOString() ?? null,
            })),
            events: latestRun.events.map((event) => ({
              id: event.id,
              participantId: event.participantId,
              participant: event.participant
                ? {
                    gatewayId: event.participant.gatewayId,
                    gatewayName: event.participant.gatewayNameSnapshot,
                    executionBackend: event.participant.executionBackend as 'platform_local' | 'gateway_openclaw',
                    harnessType: event.participant.harnessType,
                    harnessLabel: event.participant.harnessNameSnapshot,
                    role: event.participant.role,
                    agentId: event.participant.agentId,
                    agentName: event.participant.agentNameSnapshot,
                  }
                : null,
              sequence: event.sequence,
              eventType: event.eventType,
              stream: event.stream,
              content: event.content,
              metadata: event.metadata ? JSON.parse(event.metadata) : null,
              createdAt: event.createdAt.toISOString(),
            })),
          }
        : null,
    });
  } catch (error) {
    console.error('Failed to fetch latest task run:', error);
    return NextResponse.json(
      { error: 'Failed to fetch latest task run' },
      { status: 500 }
    );
  }
}
