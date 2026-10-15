import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticationErrorResponse, ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';
import { approveHumanNode, refreshTaskGraphRunStatus, releaseReadyNodes } from '@/lib/task-graph/store';
import { postGraphParentProgress } from '@/lib/task-graph/feishu';

export async function POST(request: NextRequest, { params }: { params: { id: string; nodeKey: string } }) {
  try {
    const user = await requireCurrentUser(request);
    const run = await prisma.taskGraphRun.findFirst({
      where: { id: params.id, parentTask: ownedByCurrentUser(user) }, select: { id: true, parentTaskId: true },
    });
    if (!run) return NextResponse.json({ error: 'Task graph run not found' }, { status: 404 });
    const body = await request.json() as { approved?: unknown; note?: unknown };
    if (typeof body.approved !== 'boolean' || typeof body.note !== 'string' || !body.note.trim()) {
      return NextResponse.json({ error: 'approved and a non-empty note are required' }, { status: 400 });
    }
    const node = await approveHumanNode({
      runId: run.id, nodeKey: params.nodeKey, reviewerId: user.id,
      approved: body.approved, note: body.note.trim(),
    });
    const released = body.approved ? await releaseReadyNodes(run.id) : [];
    await refreshTaskGraphRunStatus(run.id);
    void postGraphParentProgress(run.parentTaskId, run.id,
      `${params.nodeKey} 人工验收${body.approved ? '通过' : '未通过'}；${released.length ? `放行 ${released.join('、')}` : '无后续放行'}`)
      .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
    return NextResponse.json({ nodeKey: node.key, status: node.status, released });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
