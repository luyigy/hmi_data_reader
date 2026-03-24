import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { AcpxParticipantRequest, AcpxOrchestrationMode, AcpxPermissionConfig } from '@/lib/acpx/types';
import { ensureTaskSession } from '@/lib/acpx/session';
import { DEFAULT_ACPX_PERMISSION_CONFIG, normalizeAcpxPermissionConfig } from '@/lib/acpx/permissions';

const parseJson = <T,>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const formatTask = (task: any) => ({
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
  assignedAgents: task.assignedAgents.map((agent: any) => ({
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

// GET /api/tasks - 获取所有任务
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50');

    const where = status ? { status } : {};

    const tasks = await prisma.task.findMany({
      where,
      include: {
        currentTaskSession: true,
        assignedAgents: {
          include: {
            gateway: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    });

    const formatted = tasks.map(formatTask);

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tasks' },
      { status: 500 }
    );
  }
}

// POST /api/tasks - 创建新任务
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      description,
      assignedAgentIds,
      executionMode = 'standard',
      runnerTarget,
      orchestrationMode = 'single',
      acpxParticipants = [],
      acpxPermissionConfig,
      workingDirectory,
    } = body;

    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedDescription =
      typeof description === 'string' && description.trim().length > 0
        ? description.trim()
        : null;
    const normalizedParticipants =
      executionMode === 'acpx' && Array.isArray(acpxParticipants)
        ? (acpxParticipants as AcpxParticipantRequest[]).map((participant) => ({
            ...participant,
            gatewayId: participant.gatewayId?.trim(),
            gatewayName: participant.gatewayName?.trim() || undefined,
            harnessType: participant.harnessType?.trim(),
            harnessLabel: participant.harnessLabel?.trim() || undefined,
            role: participant.role?.trim(),
            agentId: participant.agentId?.trim() || undefined,
            agentName: participant.agentName?.trim() || undefined,
          }))
        : [];
    const effectiveWorkingDirectory =
      executionMode === 'acpx'
        && normalizedParticipants.some((participant) => participant.executionBackend === 'platform_local')
        && typeof workingDirectory === 'string'
        && workingDirectory.trim().length > 0
        ? workingDirectory.trim()
        : null;
    const normalizedPermissionConfig =
      executionMode === 'acpx'
        ? normalizeAcpxPermissionConfig(acpxPermissionConfig)
        : DEFAULT_ACPX_PERMISSION_CONFIG;

    if (!normalizedName) {
      return NextResponse.json(
        { error: 'Task name is required' },
        { status: 400 }
      );
    }

    if (executionMode === 'acpx') {
      if (normalizedParticipants.length === 0) {
        return NextResponse.json(
          { error: 'ACPX task requires at least one participant' },
          { status: 400 }
        );
      }

      const invalidParticipant = normalizedParticipants.find(
        (participant) =>
          !participant.gatewayId
          || !participant.harnessType
          || !participant.role
          || !participant.executionBackend
      );

      if (invalidParticipant) {
        return NextResponse.json(
          { error: 'Each ACPX participant requires gateway, harness, role, and execution backend' },
          { status: 400 }
        );
      }
    }

    const task = await prisma.task.create({
      data: {
        name: normalizedName,
        description: normalizedDescription,
        executionMode,
        runnerTarget,
        acpxParticipants:
          executionMode === 'acpx' ? JSON.stringify(normalizedParticipants) : null,
        acpxPermissionConfig:
          executionMode === 'acpx' ? JSON.stringify(normalizedPermissionConfig) : null,
        workingDirectory: effectiveWorkingDirectory,
        result:
          executionMode === 'acpx'
            ? JSON.stringify({
                executionMode: 'acpx',
                orchestrationMode: orchestrationMode as AcpxOrchestrationMode,
                participants: normalizedParticipants,
                permissionConfig: normalizedPermissionConfig,
                workingDirectory: effectiveWorkingDirectory,
              })
            : null,
        assignedAgents: assignedAgentIds
          && executionMode !== 'acpx'
          ? {
              connect: assignedAgentIds.map((id: string) => ({ id })),
            }
          : undefined,
      },
    });

    if (executionMode === 'acpx') {
      await ensureTaskSession(task.id, {
        taskName: task.name,
        metadata: {
          orchestrationMode,
          participantCount: normalizedParticipants.length,
          workingDirectory: effectiveWorkingDirectory,
        },
      });
    }

    const formatted = formatTask({
      ...task,
      currentTaskSession: null,
      assignedAgents: [],
    });

    return NextResponse.json(formatted, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to create task';
    const validationHint =
      errorMessage.includes('Invalid `prisma.task.create()` invocation')
      || errorMessage.includes('Unknown argument')
        ? ' Prisma Client may be out of date. Run `npx prisma generate` and restart the Next.js server.'
        : '';
    return NextResponse.json(
      { error: `${errorMessage}${validationHint}` },
      { status: 500 }
    );
  }
}
