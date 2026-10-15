import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  authenticationErrorResponse,
  ownedByCurrentUser,
  requireCurrentUser,
  requireExecutionAccess,
  requirePlatformLocalAdmin,
} from '@/lib/auth-users';
import { resolveWorkspaceDirectory } from '@/lib/feishu-workspace';
import type { AcpxParticipantRequest } from '@/lib/acpx/types';
import { validateTaskGraphDefinition, type GraphDefinition } from '@/lib/task-graph/domain';
import { createTaskGraphRun, releaseReadyNodes } from '@/lib/task-graph/store';
import { postGraphParentProgress } from '@/lib/task-graph/feishu';

const git = promisify(execFile);
const workspaceRoot = process.env.SCHEDULED_JOB_WORKSPACE_ROOTS?.split(':')[0] || '/data1/code';

type LaunchConfig = {
  participant: AcpxParticipantRequest;
  checks?: { name: string; argv: string[] }[];
};

const validateExecutionTargets = async (definition: GraphDefinition) => {
  const participants: AcpxParticipantRequest[] = [];
  const repositories = new Map<string, string>();
  for (const node of definition.nodes) {
    const availableChecks = new Set<string>();
    if (node.acceptance.mode === 'agent') {
      const reviewer = node.acceptance.reviewLaunchConfig as LaunchConfig | undefined;
      if (!reviewer?.participant?.gatewayId || !reviewer.participant.harnessType ||
          reviewer.participant.executionBackend !== 'platform_local') {
        throw new Error(`${node.key}: Agent 验收需要完整的本机复核 Agent 配置`);
      }
      participants.push(reviewer.participant);
    }
    for (const execution of node.executions) {
      if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(execution.gitRef)
        || !/^[a-f0-9]{40}$/.test(execution.baseCommit)) {
        throw new Error(`${node.key}/${execution.key}: Git ref 或基线提交无效`);
      }
      const repository = await resolveWorkspaceDirectory(workspaceRoot, execution.repository);
      const [{ stdout: root }, { stdout: commit }] = await Promise.all([
        git('git', ['rev-parse', '--show-toplevel'], { cwd: repository }),
        git('git', ['rev-parse', '--verify', '--end-of-options', execution.gitRef], { cwd: repository }),
      ]);
      if (root.trim() !== repository || commit.trim() !== execution.baseCommit) {
        throw new Error(`${node.key}/${execution.key}: 仓库根目录或 Git 基线已变化，请重新确认排期`);
      }
      execution.repository = repository;
      const existingBase = repositories.get(repository);
      const base = `${execution.gitRef}:${execution.baseCommit}`;
      if (existingBase && existingBase !== base) {
        throw new Error(`${node.key}/${execution.key}: 同一运行内的同仓任务须使用相同起始 ref 和提交`);
      }
      repositories.set(repository, base);
      const config = execution.launchConfig as LaunchConfig | undefined;
      const participant = config?.participant;
      if (!participant || !participant.gatewayId || !participant.harnessType
        || !participant.role || participant.executionBackend !== 'platform_local') {
        throw new Error(`${node.key}/${execution.key}: 需要一个完整的本机 Agent 配置`);
      }
      if (!Array.isArray(config?.checks) || config.checks.some((check) =>
        !check?.name?.trim() || !Array.isArray(check.argv) || check.argv.length === 0 ||
        check.argv.some((arg) => typeof arg !== 'string' || !arg.trim()))) {
        throw new Error(`${node.key}/${execution.key}: 需要显式的验证命令数组`);
      }
      config.checks.forEach((check) => availableChecks.add(check.name));
      participants.push(participant);
    }
    const nodeRepositories = new Set(node.executions.map((execution) => execution.repository));
    for (const check of node.acceptance.integrationChecks || []) {
      const repository = await resolveWorkspaceDirectory(workspaceRoot, check.repository);
      if (!nodeRepositories.has(repository)) throw new Error(`${node.key}: 纵向检查必须在本节点的仓库内运行`);
      check.repository = repository;
      availableChecks.add(check.name);
    }
    if (nodeRepositories.size > 1 && node.acceptance.mode !== 'human' &&
        (!node.acceptance.integrationChecks?.length ||
          node.acceptance.checks.some((check) => !node.acceptance.integrationChecks?.some((item) => item.name === check)))) {
      throw new Error(`${node.key}: 多仓自动或 Agent 验收需要覆盖所有验收项的固定版本纵向检查`);
    }
    if (node.acceptance.checks.some((check) => !availableChecks.has(check))) {
      throw new Error(`${node.key}: 验收项必须关联至少一个仓内验证命令`);
    }
  }
  return participants;
};

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
