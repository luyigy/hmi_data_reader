import { NextResponse } from 'next/server';
import { getFeishuLongConnectionStatus } from '@/lib/feishu-long-connection';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const status = getFeishuLongConnectionStatus();
  const ok = status.status === 'running';

  return NextResponse.json(
    {
      ok,
      ...status,
      runtimeOwner: 'standalone_process',
      message: ok
        ? 'Feishu long-connection runtime is running in the standalone Node process.'
        : 'Feishu long-connection runtime is not running. Start it with `npm run feishu:runtime`.',
    },
    { status: ok ? 200 : 503 }
  );
}
