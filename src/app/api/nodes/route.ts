import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// GET /api/nodes - 获取所有 nodes
export async function GET() {
  try {
    const nodes = await prisma.node.findMany({
      include: {
        agents: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const formatted = nodes.map((node) => ({
      ...node,
      resources: (() => {
        try {
          return node.resources ? JSON.parse(node.resources) : undefined;
        } catch {
          return undefined;
        }
      })(),
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch nodes:', error);
    return NextResponse.json(
      { error: 'Failed to fetch nodes' },
      { status: 500 }
    );
  }
}

// POST /api/nodes - 创建新 node
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, ip, resources } = body;

    const node = await prisma.node.create({
      data: {
        name,
        ip,
        resources: resources ? JSON.stringify(resources) : null,
      },
    });

    return NextResponse.json(node, { status: 201 });
  } catch (error) {
    console.error('Failed to create node:', error);
    return NextResponse.json(
      { error: 'Failed to create node' },
      { status: 500 }
    );
  }
}
