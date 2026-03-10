import { NextResponse } from 'next/server';
import { initSocketServer } from '@/lib/websocket';
import type { Server as HTTPServer } from 'http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const server =
    (request as unknown as { socket?: { server?: HTTPServer } }).socket
      ?.server ||
    (request as unknown as { res?: { socket?: { server?: HTTPServer } } }).res
      ?.socket?.server;

  initSocketServer(server);

  return NextResponse.json({ ok: true });
}
