import { NextResponse } from 'next/server';
import { claimPairingTicket, PairingTicketError } from '@/lib/pairing-tickets';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { pairingToken?: unknown; nodeName?: unknown };
    if (typeof body.pairingToken !== 'string' || !body.pairingToken.trim()) {
      return NextResponse.json({ error: 'pairingToken is required' }, { status: 400 });
    }
    const claimed = await claimPairingTicket(
      body.pairingToken,
      typeof body.nodeName === 'string' ? body.nodeName : 'local-computer',
    );
    const origin = new URL(request.url).origin;
    const wsOrigin = (process.env.REMOTE_RUNNER_PUBLIC_URL?.trim() || origin)
      .replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
    return NextResponse.json({ ...claimed, server: `${wsOrigin}/runner` });
  } catch (error) {
    if (error instanceof PairingTicketError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
