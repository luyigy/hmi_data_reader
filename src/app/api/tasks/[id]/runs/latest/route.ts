import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { reconcileTaskRunLiveness } from '@/lib/acpx/liveness';
import { ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await requireCurrentUser(request);
    const url = new URL(request.url);
    const selectedRunId = url.searchParams.get('runId');
    const task = await prisma.task.findFirst({
      where: { id: params.id, ...ownedByCurrentUser(user) },
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
        },
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }


    await reconcileTaskRunLiveness(params.id);

    const latestRun = selectedRunId
      ? task.runs.find((run) => run.id === selectedRunId) ?? null
      : task.runs[0] ?? null;

    return NextResponse.json({
      taskId: task.id,
      executionMode: task.executionMode,
      latestRun: latestRun
        ? {
            id: latestRun.id,
            taskSessionId: latestRun.taskSessionId,
            mode: latestRun.mode,
            orchestrationMode: latestRun.orchestrationMode,
            status: latestRun.status,
            controlState: latestRun.controlState,
            activityState: latestRun.activityState,
            summary: latestRun.summary,
            error: latestRun.error,
            watchdogConfig: latestRun.watchdogConfig ? JSON.parse(latestRun.watchdogConfig) : null,
            controlMetadata: latestRun.controlMetadata ? JSON.parse(latestRun.controlMetadata) : null,
            lastActivityAt: latestRun.lastActivityAt?.toISOString() ?? null,
            lastStdoutAt: latestRun.lastStdoutAt?.toISOString() ?? null,
            lastStderrAt: latestRun.lastStderrAt?.toISOString() ?? null,
            startedAt: latestRun.startedAt?.toISOString() ?? null,
            completedAt: latestRun.completedAt?.toISOString() ?? null,
            participants: latestRun.participants.map((participant) => ({
              id: participant.id,
              gatewayId: participant.gatewayId,
              gatewayName: participant.gatewayNameSnapshot,
              executionBackend: participant.executionBackend as 'platform_local' | 'gateway_openclaw' | 'remote_ssh',
              harnessType: participant.harnessType,
              harnessLabel: participant.harnessNameSnapshot,
              role: participant.role,
              agentId: participant.agentId,
              agentName: participant.agentNameSnapshot,
              status: participant.status,
              activityState: participant.activityState,
              summary: participant.summary,
              error: participant.error,
              filesModified: participant.filesModified ? JSON.parse(participant.filesModified) : [],
              controlMetadata: participant.controlMetadata ? JSON.parse(participant.controlMetadata) : null,
              lastActivityAt: participant.lastActivityAt?.toISOString() ?? null,
              interruptSupported: participant.interruptSupported,
              resumeSupported: participant.resumeSupported,
              sessionControlSupported: participant.sessionControlSupported,
              softStopSupported: participant.softStopSupported,
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
                    executionBackend: event.participant.executionBackend as 'platform_local' | 'gateway_openclaw' | 'remote_ssh',
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
