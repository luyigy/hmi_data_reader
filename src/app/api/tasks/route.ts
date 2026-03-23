import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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

    const formatted = tasks.map((task) => ({
      ...task,
      result: task.result ? JSON.parse(task.result) : null,
      assignedAgents: task.assignedAgents.map((agent) => ({
        ...agent,
        gateway: agent.gateway
          ? {
              id: agent.gateway.id,
              name: agent.gateway.name,
            }
          : null,
        capabilities: (() => {
          try {
            return JSON.parse(agent.capabilities || '[]');
          } catch {
            return [];
          }
        })(),
      })),
    }));

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
      priority = 'medium',
    } = body;

    if (!name) {
      return NextResponse.json(
        { error: 'Task name is required' },
        { status: 400 }
      );
    }

    const task = await prisma.task.create({
      data: {
        name,
        description,
        assignedAgents: assignedAgentIds
          ? {
              connect: assignedAgentIds.map((id: string) => ({ id })),
            }
          : undefined,
      },
      include: {
        assignedAgents: {
          include: {
            gateway: true,
          },
        },
      },
    });

    const formatted = {
      ...task,
      result: null,
      assignedAgents: task.assignedAgents.map((agent) => ({
        ...agent,
        gateway: agent.gateway
          ? {
              id: agent.gateway.id,
              name: agent.gateway.name,
            }
          : null,
        capabilities: (() => {
          try {
            return JSON.parse(agent.capabilities || '[]');
          } catch {
            return [];
          }
        })(),
      })),
    };

    return NextResponse.json(formatted, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    return NextResponse.json(
      { error: 'Failed to create task' },
      { status: 500 }
    );
  }
}
