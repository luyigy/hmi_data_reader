import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticationErrorResponse, ownedByCurrentUser, requireCurrentUser } from '@/lib/auth-users';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireCurrentUser(request);
    const run = await prisma.taskGraphRun.findFirst({
      where: { id: params.id, parentTask: ownedByCurrentUser(user) },
      include: {
        nodes: {
          orderBy: { createdAt: 'asc' },
          include: { executions: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, key: true, repository: true, status: true, childTaskId: true,
              taskRunId: true, worktreePath: true, worktreeBranch: true, commit: true,
              evidence: true, issueKind: true },
          } },
        },
        events: { orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, nodeId: true, payload: true, createdAt: true } },
      },
    });
    if (!run) return NextResponse.json({ error: 'Task graph run not found' }, { status: 404 });
    return NextResponse.json(run);
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
