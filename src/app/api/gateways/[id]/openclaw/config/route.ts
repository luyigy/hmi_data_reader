import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import { encryptToken } from '@/lib/encryption';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    noStore();

    const gateway = await prisma.gateway.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        url: true,
        openclawToken: true,
      },
    });

    if (!gateway) {
      return NextResponse.json(
        { error: 'Gateway not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      gateway: {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        hasOpenClawToken: !!gateway.openclawToken,
      },
    });
  } catch (error) {
    console.error('Failed to fetch OpenClaw config:', error);
    return NextResponse.json(
      { error: 'Failed to fetch OpenClaw config' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: token' },
        { status: 400 }
      );
    }

    const gateway = await prisma.gateway.update({
      where: { id: params.id },
      data: {
        openclawToken: encryptToken(token),
      },
      select: {
        id: true,
        name: true,
        url: true,
      },
    });

    return NextResponse.json({
      success: true,
      gateway: {
        ...gateway,
        hasOpenClawToken: true,
      },
    });
  } catch (error) {
    console.error('Failed to save OpenClaw config:', error);
    return NextResponse.json(
      { error: 'Failed to save OpenClaw config' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const gateway = await prisma.gateway.update({
      where: { id: params.id },
      data: {
        openclawToken: null,
      },
      select: {
        id: true,
        name: true,
        url: true,
      },
    });

    return NextResponse.json({
      success: true,
      gateway: {
        ...gateway,
        hasOpenClawToken: false,
      },
    });
  } catch (error) {
    console.error('Failed to clear OpenClaw config:', error);
    return NextResponse.json(
      { error: 'Failed to clear OpenClaw config' },
      { status: 500 }
    );
  }
}
