import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// GET /api/agents/[id] - 获取单个 agent
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: params.id },
      include: {
        node: true,
        tasks: true,
      },
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    const formatted = {
      ...agent,
      capabilities: (() => {
        try {
          return JSON.parse(agent.capabilities || '[]');
        } catch {
          return [];
        }
      })(),
    };

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch agent:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agent' },
      { status: 500 }
    );
  }
}

// PUT /api/agents/[id] - 更新 agent 状态
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { status, nodeId, ...otherFields } = body;

    // 验证状态
    const validStatuses = ['online', 'offline', 'busy', 'error'];
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }

    const agent = await prisma.agent.findUnique({
      where: { id: params.id },
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    const updated = await prisma.agent.update({
      where: { id: params.id },
      data: {
        ...otherFields,
        status,
        nodeId,
        lastHeartbeat: status ? new Date() : undefined,
      },
      include: {
        node: true,
      },
    });

    const formatted = {
      ...updated,
      capabilities: (() => {
        try {
          return JSON.parse(updated.capabilities || '[]');
        } catch {
          return [];
        }
      })(),
    };

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to update agent:', error);
    return NextResponse.json(
      { error: 'Failed to update agent' },
      { status: 500 }
    );
  }
}

// DELETE /api/agents/[id] - 删除 agent
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: params.id },
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    await prisma.agent.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: 'Agent deleted' });
  } catch (error) {
    console.error('Failed to delete agent:', error);
    return NextResponse.json(
      { error: 'Failed to delete agent' },
      { status: 500 }
    );
  }
}
