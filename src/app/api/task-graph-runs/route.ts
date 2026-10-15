import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  authenticationErrorResponse,
  ownedByCurrentUser,
  requireCurrentUser,
  requireExecutionAccess,
  requirePlatformLocalAdmin,
} from '@/lib/auth-users';
import { validateTaskGraphDefinition, type GraphDefinition } from '@/lib/task-graph/domain';
import { validateExecutionTargets } from '@/lib/task-graph/launch';
import { createTaskGraphRun, releaseReadyNodes } from '@/lib/task-graph/store';
import { postGraphParentProgress } from '@/lib/task-graph/feishu';

/** Human confirmation freezes one graph; workers dispatch only its ready nodes. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireCurrentUser(request);
    requirePlatformLocalAdmin(user, ['platform_local']);
    const body = await request.json() as Record<string, unknown>;
    const parentTaskId = typeof body.parentTaskId === 'string' ? body.parentTaskId : '';
    const version = body.version;
    const requestKey = request.headers.get('idempotency-key')?.trim() || '';
    if (!parentTaskId || !Number.isInteger(version) || (version as number) < 1 ||
        !requestKey || requestKey.length > 120 || !body.definition) {
      return NextResponse.json({ error: 'parentTaskId, version, definition and Idempotency-Key are required' }, { status: 400 });
    }
    const parent = await prisma.task.findFirst({ where: { id: parentTaskId, ...ownedByCurrentUser(user) } });
    if (!parent) return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
    const definition = body.definition as GraphDefinition;
    if (Array.isArray(definition?.nodes)) {
      for (const node of definition.nodes) {
        if (node.acceptance?.mode === 'human' && node.acceptance.reviewerId === 'self') {
          node.acceptance.reviewerId = user.id;
        }
      }
    }
    validateTaskGraphDefinition(definition);
    if (definition.nodes.some((node) => node.acceptance.mode === 'human' && node.acceptance.reviewerId !== user.id)) {
      throw new Error('人工验收人必须是当前父任务负责人');
    }
    const participants = await validateExecutionTargets(definition);
    await requireExecutionAccess(user, participants);
    const run = await createTaskGraphRun({ parentTaskId, version: version as number, requestKey, definition });
    const released = await releaseReadyNodes(run.id);
    if (released.length) {
      void postGraphParentProgress(parentTaskId, run.id, `路线已启动；当前放行：${released.join('、')}`)
        .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
    }
    return NextResponse.json({ id: run.id, parentTaskId, version }, { status: 201 });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireCurrentUser(request);
    const parentTaskId = request.nextUrl.searchParams.get('parentTaskId') || '';
    if (!parentTaskId) return NextResponse.json({ error: 'parentTaskId is required' }, { status: 400 });
    const runs = await prisma.taskGraphRun.findMany({
      where: { parentTaskId, parentTask: ownedByCurrentUser(user) },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, status: true, createdAt: true, snapshotHash: true },
    });
    return NextResponse.json({ runs });
  } catch (error) {
    const authError = authenticationErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
