import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// GET /api/gateways - 获取所有 gateways
export async function GET() {
  try {
    const gateways = await prisma.gateway.findMany({
      include: {
        agents: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const formatted = gateways.map((gateway) => ({
      ...gateway,
      resources: (() => {
        try {
          return gateway.resources ? JSON.parse(gateway.resources) : undefined;
        } catch {
          return undefined;
        }
      })(),
    }));

    return NextResponse.json(formatted);
  } catch (error) {
    console.error('Failed to fetch gateways:', error);
    return NextResponse.json(
      { error: 'Failed to fetch gateways' },
      { status: 500 }
    );
  }
}

// POST /api/gateways - 创建新 gateway
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, url, token, ip, resources } = body;

    const gateway = await prisma.gateway.create({
      data: {
        name,
        url,
        token,
        ip,
        resources: resources ? JSON.stringify(resources) : null,
      },
    });

    return NextResponse.json(gateway, { status: 201 });
  } catch (error) {
    console.error('Failed to create gateway:', error);
    return NextResponse.json(
      { error: 'Failed to create gateway' },
      { status: 500 }
    );
  }
}
