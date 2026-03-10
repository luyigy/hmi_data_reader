import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureDefaultRooms } from '@/lib/chat';

export const dynamic = 'force-dynamic';

// GET /api/chat/rooms - 获取房间列表
export async function GET() {
  try {
    await ensureDefaultRooms();
    const rooms = await prisma.chatRoom.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json(rooms);
  } catch (error) {
    console.error('Failed to fetch chat rooms:', error);
    return NextResponse.json(
      { error: 'Failed to fetch chat rooms' },
      { status: 500 }
    );
  }
}
