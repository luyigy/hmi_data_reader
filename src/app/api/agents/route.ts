import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// GET /api/agents - 获取所有 agents
export async function GET() {
  try {
    const agents = await prisma.agent.findMany({
      include: {
        node: true,
        tasks: true,
      },
    });
    return NextResponse.json(agents);
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agents' },
      { status: 500 }
    );
  }
}

// POST /api/agents - 创建新 agent
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, type, location, capabilities, nodeId } = body;

    const agent = await prisma.agent.create({
      data: {
        name,
        type,
        location,
        capabilities: JSON.stringify(capabilities || []),
        nodeId,
      },
    });

    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('Failed to create agent:', error);
    return NextResponse.json(
      { error: 'Failed to create agent' },
      { status: 500 }
    );
  }
}
