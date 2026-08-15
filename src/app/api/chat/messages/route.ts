import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { ChatMessageTargetType } from '@/lib/chat-types';
import { ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

const mapMessage = (message: {
  id: string;
  content: string;
  roomId: string;
  userId: string;
  userName: string;
  targetType: string;
  targetParticipantKey: string | null;
  targetParticipantLabel: string | null;
  createdAt: Date;
}) => ({
  id: message.id,
  roomId: message.roomId,
  user: {
    id: message.userId,
    name: message.userName,
  },
  content: message.content,
  target: {
    type: message.targetType as ChatMessageTargetType,
    participantKey: message.targetParticipantKey,
    participantLabel: message.targetParticipantLabel,
  },
  createdAt: message.createdAt.toISOString(),
});

const canAccessRoom = async (request: NextRequest, roomId: string) => {
  const user = await requireCurrentUser(request);
  if (user.role === 'admin') return true;
  const room = await prisma.chatRoom.findUnique({ where: { id: roomId }, select: { description: true } });
  const taskId = room?.description?.match(/(?:^|\n)TASK_ROOM:([^\s]+)/)?.[1];
  return Boolean(taskId && await prisma.task.findFirst({
    where: { id: taskId, ...ownedByCurrentUser(user) },
    select: { id: true },
  }));
};

// GET /api/chat/messages?roomId=xxx&limit=50&before=2024-01-01T00:00:00.000Z
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const roomId = searchParams.get('roomId');
    if (!roomId) {
      return NextResponse.json(
        { error: 'roomId is required' },
        { status: 400 }
      );
    }
    if (!await canAccessRoom(request, roomId)) {
      return NextResponse.json({ error: 'Chat room not found' }, { status: 404 });
    }

    const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
    const before = searchParams.get('before');

    const messages = await prisma.message.findMany({
      where: {
        roomId,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return NextResponse.json(messages.map(mapMessage).reverse());
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}

// POST /api/chat/messages - 发送消息
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { content, roomId, userId, userName, targetType, targetParticipantKey, targetParticipantLabel } = body;

    if (!content || !roomId || !userId || !userName) {
      return NextResponse.json(
        { error: 'content, roomId, userId, userName are required' },
        { status: 400 }
      );
    }
    if (!await canAccessRoom(request, roomId)) {
      return NextResponse.json({ error: 'Chat room not found' }, { status: 404 });
    }

    if (targetType && targetType !== 'task' && targetType !== 'participant' && targetType !== 'all') {
      return NextResponse.json(
        { error: 'Invalid targetType' },
        { status: 400 }
      );
    }

    if (targetType === 'participant' && (!targetParticipantKey || !targetParticipantLabel)) {
      return NextResponse.json(
        { error: 'targetParticipantKey and targetParticipantLabel are required for participant target' },
        { status: 400 }
      );
    }

    const message = await prisma.message.create({
      data: {
        content,
        roomId,
        userId,
        userName,
        targetType: targetType || 'task',
        targetParticipantKey: targetType === 'participant' ? targetParticipantKey : null,
        targetParticipantLabel: targetType === 'participant' ? targetParticipantLabel : null,
      },
    });

    return NextResponse.json(mapMessage(message), { status: 201 });
  } catch (error) {
    console.error('Failed to create message:', error);
    return NextResponse.json(
      { error: 'Failed to create message' },
      { status: 500 }
    );
  }
}
