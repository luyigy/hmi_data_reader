import { NextResponse } from 'next/server';
import {
  ensureFeishuLongConnectionStarted,
  getFeishuLongConnectionStatus,
} from '@/lib/feishu-long-connection';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const status = await ensureFeishuLongConnectionStarted();
    return NextResponse.json({
      ok: true,
      ...status,
    });
  } catch (error) {
    const status = getFeishuLongConnectionStatus();
    return NextResponse.json(
      {
        ok: false,
        ...status,
        error: error instanceof Error ? error.message : 'Failed to start Feishu long connection',
      },
      { status: 500 }
    );
  }
}
