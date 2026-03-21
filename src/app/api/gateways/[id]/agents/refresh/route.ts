import { NextRequest, NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import { syncGatewayAgents } from '@/lib/openclaw-gateway-rpc';

export const dynamic = 'force-dynamic';

function resolvePlatformOrigin(request: NextRequest): string {
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin) {
    return requestOrigin;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    noStore();

    const result = await syncGatewayAgents(
      params.id,
      resolvePlatformOrigin(request)
    );

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Failed to refresh gateway agents:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : '刷新 Gateway agents 失败',
      },
      { status: 500 }
    );
  }
}
