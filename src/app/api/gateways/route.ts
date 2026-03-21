import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import { encryptToken } from '@/lib/encryption';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/gateways - 获取所有 gateways
export async function GET() {
  try {
    noStore();

    const gateways = await prisma.gateway.findMany({
      select: {
        id: true,
        name: true,
        url: true,
        ip: true,
        status: true,
        resources: true,
        createdAt: true,
        updatedAt: true,
        token: true,
        openclawToken: true,
        agents: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const formatted = gateways.map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      url: gateway.url,
      ip: gateway.ip,
      status: gateway.status,
      createdAt: gateway.createdAt,
      updatedAt: gateway.updatedAt,
      hasToken: !!gateway.token,
      hasOpenClawToken: !!gateway.openclawToken,
      agents: gateway.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        runtimeAgentId: (agent as { runtimeAgentId?: string | null }).runtimeAgentId || undefined,
        type: agent.type,
        status: agent.status,
      })),
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
    const { name, url, token, openclawToken, ip, resources } = body;

    const gateway = await prisma.gateway.create({
      data: {
        name,
        url,
        token: token ? encryptToken(token) : null,
        openclawToken: openclawToken ? encryptToken(openclawToken) : null,
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
