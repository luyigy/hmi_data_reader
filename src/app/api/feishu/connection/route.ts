import { NextResponse } from 'next/server';
import { getFeishuLongConnectionStatus } from '@/lib/feishu-long-connection';
import { isFeishuConnectionHealthy } from '@/lib/feishu-runtime-status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const status = getFeishuLongConnectionStatus();
  const ok = isFeishuConnectionHealthy(status);

  return NextResponse.json(
    {
      ok,
      ...status,
      runtimeOwner: 'standalone_process',
      message: ok
        ? 'Feishu long connection is receiving server heartbeats.'
        : status.status === 'running'
          ? 'Feishu runtime is running, but its long connection has not confirmed a server heartbeat.'
          : 'Feishu long-connection runtime is not running. Start it with `npm run feishu:runtime`.',
    },
    { status: ok ? 200 : 503 }
  );
}
