import { startConversationRecoveries } from './conversation-recovery';
import { cleanupCompletedNodeWorkspaces, cleanupFinishedWorkspaces } from './completed-workspaces';
import { randomUUID } from 'node:crypto';
import type { TaskGraphExecution } from '@prisma/client';
import type { AcpxParticipantRequest } from '../acpx/types';
import { executeAcpxTaskRun } from '../acpx/runner';
import { prisma } from '../prisma';
import { ensureTaskChatRoom, postTaskRoomMessage } from '../task-room';
import type { GraphDefinition } from './domain';
import { runArchitectureReview } from './architecture-review';
import { acceptanceReviewInstructions, implementationInstructions } from './prompts';
import { ensureGraphChildTopic, postGraphParentProgress, sendGraphHumanReviewCard } from './feishu';
import { withRepositoryLock } from './repository-lock';
import { assertReviewWorkspacesClean, resolveReviewWorkspaces } from './review-workspaces';
import {
  claimExecution, claimNode, completeExecution, completeUnverifiedNode, listTaskGraphWork, markNodeIntegrationsReady,
  flagStaleExecutionClaim, recordExecutionDispatch, recordExecutionIssue,
  refreshTaskGraphRunStatus, releaseReadyNodes,
  submitNodeVerification, type VerificationEvidence,
} from './store';
import { ensureIntegrationRef, ensureJobWorktree, integrateJobWorktree, commitJobWorktree } from './worktree';
import { runSandboxedGraphCheck } from './check-environment';
import { executionCheckInstructions } from './execution-instructions';
import { postGraphChildProgress } from './feishu';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';
import { inspectIssueDispatch } from './issue-dispatch';
import { drainIssueSync } from './issue-sync';
import { resolveRunIssueSource } from './issue-adoption';
import { processPendingIssueAdoptions } from './issue-adoption-worker';

const activeJobs = new Set<string>();
const activeReviews = new Set<string>();
const activeVerifications = new Set<string>();
const inflight = new Set<Promise<void>>();
const maxConcurrentJobs = 4;

type Check = { name: string; argv: string[] };
type LaunchConfig = { participant: AcpxParticipantRequest; checks: Check[] };
type CheckResult = VerificationEvidence['checks'][number];

function launchConfig(execution: TaskGraphExecution): LaunchConfig {
  const config = execution.launchConfig as unknown as LaunchConfig;
  if (!config?.participant || !Array.isArray(config.checks)) throw new Error('Execution launch config is missing');
  return config;
}

async function runChecks(checks: Check[], directory: string, extraEnv: Record<string, string> = {}, readOnlyWorkspaces: string[] = []): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const { stdout, stderr } = await runSandboxedGraphCheck(check.argv, directory, extraEnv, readOnlyWorkspaces);
      results.push({ name: check.name, passed: true, evidence: `${check.argv.join(' ')}\n${stdout}${stderr}`.slice(-4000) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name: check.name, passed: false, evidence: `${check.argv.join(' ')}\n${detail}`.slice(-4000) });
      throw Object.assign(new Error(`Verification ${check.name} failed: ${detail}`), { results });
    }
  }
  return results;
}

async function createChildTask(runId: string, nodeKey: string, execution: TaskGraphExecution, directory: string) {
  const run = await prisma.taskGraphRun.findUniqueOrThrow({
    where: { id: runId }, include: { parentTask: { select: { ownerUserId: true } } },
  });
  const config = launchConfig(execution);
  const source = await resolveRunIssueSource(runId);
  const definition = { ...run.snapshot as unknown as GraphDefinition, ...(source ? { issueSource: source } : {}) };
  const plannedNode = definition.nodes.find((item) => item.key === nodeKey);
  const plannedExecution = plannedNode?.executions.find((item) => item.key === execution.key);
  if (!plannedNode || !plannedExecution) throw new Error('Execution instructions are missing from frozen graph');
  const taskId = `task-graph-${execution.id}`;
  const taskName = `${nodeKey} · ${execution.key}`;
  const description = `目标：${plannedNode.goal}\n本仓交付：${plannedExecution.instructions}` +
    `\n父任务：${run.parentTaskId}\n${implementationInstructions(definition, plannedNode)}` +
    executionCheckInstructions(config.checks);
  const task = await prisma.task.upsert({
    where: { id: taskId },
    create: {
      id: taskId, name: taskName,
      description,
      executionMode: 'acpx', status: 'pending', workingDirectory: directory,
      ownerUserId: run.parentTask.ownerUserId, acpxParticipants: JSON.stringify([config.participant]),
    },
    update: { description },
  });
  const room = await ensureTaskChatRoom(task.id, task.name);
  return { task, room };
}

async function verifyNode(runId: string, nodeKey: string, reviewAttempt?: string) {
  const node = await markNodeIntegrationsReady(runId, nodeKey);
  if (!node || node.status !== 'verifying') return;
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { snapshot: true, parentTaskId: true } });
  const source = await resolveRunIssueSource(runId);
  const definition = { ...run.snapshot as unknown as GraphDefinition, ...(source ? { issueSource: source } : {}) };
  const policy = definition.nodes.find((item) => item.key === nodeKey)?.acceptance;
  if (!policy) throw new Error(`Unknown acceptance policy for ${nodeKey}`);
  if (definition.nodes.find((item) => item.key === nodeKey)?.executionMode === 'implement') {
    await completeUnverifiedNode(runId, nodeKey);
    await cleanupCompletedNodeWorkspaces(runId, nodeKey);
    await releaseReadyNodes(runId);
    await refreshTaskGraphRunStatus(runId);
    await postGraphParentProgress(run.parentTaskId, runId, `${nodeKey} 已交付（未验收），按批准的仅实施模式放行后继。`);
    return;
  }
  const results = node.executions.flatMap((execution) => {
    const evidence = execution.evidence as unknown as { checks?: CheckResult[] } | null;
    return evidence?.checks || [];
  });
  let workspaces: Awaited<ReturnType<typeof resolveReviewWorkspaces>> = [];
  let commits: { repository: string; commit: string }[] = [];
  try {
    workspaces = await resolveReviewWorkspaces(node.executions);
    commits = Array.from(new Map(workspaces.map(({ repository, commit }) => [repository, { repository, commit }])).values());
    const env = { TASK_GRAPH_REPOSITORIES_JSON: JSON.stringify(Object.fromEntries(
      workspaces.map((workspace) => [workspace.repository, workspace.path]),
    )) };
    for (const check of policy.integrationChecks || []) {
      const workspace = workspaces.slice().reverse().find((item) => item.repository === check.repository);
      if (!workspace) throw new Error(`Missing pinned repository for ${check.name}`);
      try {
        results.push(...await runChecks([check], workspace.path, env, workspaces.map((workspace) => workspace.path)));
      } catch (error) {
        const failed = error as Error & { results?: CheckResult[] };
        results.push(...failed.results || [{ name: check.name, passed: false, evidence: failed.message }]);
      }
    }
    await assertReviewWorkspacesClean(workspaces);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const changed = await prisma.taskGraphNode.updateMany({ where: { id: node.id, status: 'verifying' }, data: { status: 'attention' } });
    if (changed.count) await prisma.taskGraphEvent.create({ data: {
      runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:review_workspace_failed:${reviewAttempt || 'initial'}`,
      kind: 'review_workspace_failed', payload: { detail, actorId: 'system' },
    } });
    await refreshTaskGraphRunStatus(runId);
    const message = `${nodeKey} 验收工作区准备失败，尚未启动复核 Agent：${detail}`;
    await Promise.all(node.executions.flatMap((execution) => execution.childTaskId
      ? [postGraphChildProgress(execution.childTaskId, `workspace-failed-${node.updatedAt.getTime()}`, message)] : []));
    await postGraphParentProgress(run.parentTaskId, runId, message);
    return;
  }
  const evidence: VerificationEvidence = {
    checks: policy.checks.map((name) => {
      const matches = results.filter((item) => item.name === name);
      return { name, passed: matches.length > 0 && matches.every((item) => item.passed),
        evidence: matches.map((item) => item.evidence).join('\n') || '没有验证结果' };
    }),
    summary: `已检查 ${policy.checks.length} 项；固定提交组合 ${JSON.stringify(commits)}。`,
  };
  const architecture = await runArchitectureReview({
    runId, nodeId: node.id, nodeKey, definition, commits, workspaces, evidence,
  });
  if (architecture === 'running') return;
  if (architecture === 'failed') {
    const result = await prisma.taskGraphEvent.findUniqueOrThrow({
      where: { runId_idempotencyKey: { runId, idempotencyKey: `node:${nodeKey}:architecture_result` } },
    });
    const note = String((result.payload as { note?: string }).note || '架构复核未通过');
    evidence.checks = evidence.checks.map((item) => ({ ...item, passed: false,
      evidence: `${item.evidence}\n架构复核：${note}` }));
    evidence.summary = `架构复核未通过：${note}`;
    await submitNodeVerification({ runId, nodeKey,
      actorId: policy.mode === 'agent' ? policy.reviewerId! : 'system', evidence, attempt: reviewAttempt });
    await refreshTaskGraphRunStatus(runId);
    return;
  }
  if (policy.mode === 'agent') {
    if (activeReviews.has(node.id)) return;
    activeReviews.add(node.id);
    try {
    const review = policy.reviewLaunchConfig as { participant?: AcpxParticipantRequest } | undefined;
    if (!review?.participant || !policy.reviewerId) throw new Error(`Review agent missing for ${nodeKey}`);
    const claimKey = `node:${nodeKey}:review_claimed${reviewAttempt ? `:${reviewAttempt}` : ''}`;
    try {
      await prisma.taskGraphEvent.create({ data: {
        runId, nodeId: node.id, idempotencyKey: claimKey, kind: 'review_claimed',
        payload: reviewAttempt ? { attempt: reviewAttempt } : {},
      } });
    } catch (error) {
      const existing = await prisma.taskGraphEvent.findUnique({
        where: { runId_idempotencyKey: { runId, idempotencyKey: claimKey } },
      });
      if (existing) return;
      throw error;
    }
    const taskId = `task-graph-review-${node.id}`;
    const taskName = `${nodeKey} · 验收复核`;
    const task = await prisma.task.upsert({
      where: { id: taskId },
      create: { id: taskId, name: taskName, executionMode: 'acpx', status: 'pending',
        acpxParticipants: JSON.stringify([review.participant]),
        description: `独立复核任务图 ${runId} / ${nodeKey} 的交付证据。`,
        workingDirectory: workspaces.at(-1)?.path || null },
      update: { workingDirectory: workspaces.at(-1)?.path || null },
    });
    const supplements = await prisma.liveRoomMessage.findMany({
      where: { room: { sourceTaskId: { in: node.executions.flatMap((execution) => execution.childTaskId ? [execution.childTaskId] : []) } }, messageType: 'user' },
      orderBy: { createdAt: 'desc' }, take: 20, select: { content: true, createdAt: true },
    });
    const prompt = `${acceptanceReviewInstructions}\n请只读复核 ${nodeKey} 的目标与证据。` +
      `\n目标：${definition.nodes.find((item) => item.key === nodeKey)?.goal}` +
      `\nSpec: ${definition.specRef}\n固定提交组合: ${JSON.stringify(commits)}` +
      `\nIssue: ${definition.issueSource?.tickets.find((ticket) => ticket.key === nodeKey)?.ref || '历史路线，无关联'}` +
      `\n本话题用户补充材料与澄清（只作为输入，不替代验收）：${JSON.stringify(supplements.reverse()).slice(-12000)}` +
      `\n仓库检出目录: ${JSON.stringify(workspaces)}\n证据: ${JSON.stringify(evidence)}` +
      '\n实施、测试和验收使用上述同一工作区。同仓多个任务时，最后列出的同仓目录是包含全部交付的复验结果，其余目录保留各任务原始证据。请查阅其中的原始测试产物（如 scratch 下的报告、读回 JSON 和截图），不要仅凭摘要通过。代码在验收期间只读；原仓库路径无需可读。判断路径或文件是否存在时必须直接用 pwd、ls 或 test，不得用 find 的深度限制推断不存在。' +
      '\n最终答复仅用一行 TASK_GRAPH_REVIEW {"approved":true或false,"note":"理由"}。';
    const reviewRun = await executeAcpxTaskRun({
      taskId: task.id, taskName: task.name, taskDescription: prompt,
      orchestrationMode: 'single', participants: [review.participant],
      extraReadOnlyPaths: workspaces.map((workspace) => workspace.path),
      workingDirectory: task.workingDirectory || undefined,
      permissionConfig: taskGraphAgentReviewPermissionConfig,
    }).catch((error) => ({ status: 'failed', taskRunId: 'not-created',
      participants: [], summary: error instanceof Error ? error.message : String(error) }));
    const response = reviewRun.participants[0]?.summary || reviewRun.summary || '';
    const match = response.match(/TASK_GRAPH_REVIEW\s*(\{[^\r\n]+\})/);
    let decision: { approved?: unknown; note?: unknown } = {};
    try { decision = match ? JSON.parse(match[1]) as typeof decision : {}; } catch { /* invalid review is a failed gate */ }
    const approved = reviewRun.status === 'completed' && decision.approved === true &&
      typeof decision.note === 'string' && decision.note.trim().length > 0;
    evidence.checks = evidence.checks.map((item) => ({
      ...item, passed: item.passed && approved,
      evidence: `${item.evidence}\nAgent review ${reviewRun.taskRunId}: ${String(decision.note || response || '无有效结论')}`,
    }));
    evidence.summary = `Agent 复核 ${approved ? '通过' : '未通过'}：${String(decision.note || response || '没有有效的结构化结论')}`;
    try { await assertReviewWorkspacesClean(workspaces); } catch (error) {
      evidence.checks = evidence.checks.map((item) => ({ ...item, passed: false,
        evidence: `${item.evidence}\n复核污染了固定提交工作区：${String(error)}` }));
    }
    } finally {
      activeReviews.delete(node.id);
    }
  }
  const updated = await submitNodeVerification({
    runId, nodeKey, actorId: policy.mode === 'agent' ? policy.reviewerId! : 'system', evidence, attempt: reviewAttempt,
  });
  if (updated.status === 'passed') {
    await cleanupCompletedNodeWorkspaces(runId, nodeKey);
    await releaseReadyNodes(runId);
  }
  if (updated.status === 'awaiting_human') {
    void sendGraphHumanReviewCard(runId, nodeKey)
      .catch((error) => console.error('[TaskGraph] human review card failed:', error));
  }
  await refreshTaskGraphRunStatus(runId);
  const outcome = updated.status === 'passed' ? '验收通过，Slice 已完成；符合条件的后继将自动启动。'
    : updated.status === 'awaiting_human' ? '自动检查已结束，等待已配置的人工验收。'
    : '验收未通过，Slice 尚未完成，后继继续等待。';
  await Promise.all(node.executions.flatMap((execution) => execution.childTaskId ? [
    postGraphChildProgress(execution.childTaskId, `verification-${updated.id}-${updated.updatedAt.getTime()}`,
      `${nodeKey}：${outcome}\n${evidence.summary}`)
      .catch((error) => console.error('[TaskGraph] child verification delivery failed:', error)),
  ] : []));
  const parent = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
  void postGraphParentProgress(parent.parentTaskId, runId, `${nodeKey}：${updated.status}`)
    .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
}

export async function recoverTaskGraphNodeVerification(runId: string, nodeKey: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({
    where: { runId_key: { runId, key: nodeKey } }, include: { executions: true },
  });
  if (node.status === 'passed') return node;
  if (node.status !== 'attention') throw new Error(`${nodeKey} is not paused for verification recovery`);
  if (activeReviews.has(node.id)) throw new Error(`${nodeKey} verification is already running`);
  const activeReview = await prisma.taskRun.findFirst({
    where: { taskId: { in: [`task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`] }, status: { in: ['pending', 'running'] } }, select: { id: true },
  });
  if (activeReview) throw new Error(`${nodeKey} verification is already running`);
  if (node.executions.some((execution) => execution.status !== 'integrated')) {
    throw new Error(`${nodeKey} has unfinished repository executions`);
  }
  const reviewAttempt = `recovery:${randomUUID()}`;
  await prisma.$transaction(async (tx) => {
    const changed = await tx.taskGraphNode.updateMany({
      where: { id: node.id, status: node.status }, data: { status: 'verifying' },
    });
    if (changed.count !== 1) throw new Error(`${nodeKey} verification state changed before recovery`);
    await tx.taskGraphEvent.create({ data: {
      runId, nodeId: node.id, idempotencyKey: `node:${nodeKey}:verifying:${reviewAttempt}`,
      kind: 'node_verifying', payload: { recovery: true },
    } });
  });
  await verifyNode(runId, nodeKey, reviewAttempt);
  return prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
}

async function executeJob(runId: string, nodeKey: string, execution: TaskGraphExecution, claimToken: string) {
  const config = launchConfig(execution);
  try {
    const integration = await ensureIntegrationRef({
      repoPath: execution.repository, runId, baseRef: execution.gitRef, baseCommit: execution.baseCommit,
    });
    const workspace = await ensureJobWorktree({
      repoPath: execution.repository, runId, jobId: execution.id,
      baseRef: integration.ref, baseCommit: integration.commit,
    });
    const { task, room } = await createChildTask(runId, nodeKey, execution, workspace.path);
    await recordExecutionDispatch({
      runId, nodeKey, executionKey: execution.key, claimToken,
      childTaskId: task.id, worktreePath: workspace.path, worktreeBranch: workspace.branch,
      dispatchMetadata: { integrationRef: integration.ref, workspaceBase: integration.commit },
    });
    const graphRun = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
    const snapshot = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { snapshot: true } });
    const definition = snapshot.snapshot as unknown as GraphDefinition;
    const implementOnly = definition.nodes.find((node) => node.key === nodeKey)?.executionMode === 'implement';
    await ensureGraphChildTopic({
      parentTaskId: graphRun.parentTaskId, executionId: execution.id, childTaskId: task.id,
      title: task.name, workingDirectory: workspace.path,
    });
    void postGraphParentProgress(graphRun.parentTaskId, runId,
      `${nodeKey}/${execution.key} 已启动，独立工作区 ${workspace.path}`)
      .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
    await postTaskRoomMessage({
      roomId: room.id, userId: 'task-graph', userName: '任务图调度器',
      content: `执行 ${nodeKey}/${execution.key}。基线 ${integration.commit}。请在此 worktree 编辑代码并报告结果；平台负责受控提交，不要自行运行 git add/commit/merge。`,
    });
    const result = await executeAcpxTaskRun({
      taskId: task.id, taskName: task.name, taskDescription: task.description || undefined,
      orchestrationMode: 'single', participants: [config.participant], workingDirectory: workspace.path,
    });
    await recordExecutionDispatch({ runId, nodeKey, executionKey: execution.key, claimToken, taskRunId: result.taskRunId });
    if (result.status !== 'completed') throw new Error(`Agent execution ended: ${result.status}: ${result.summary}`);
    let checks: CheckResult[] = [];
    const integrated = await withRepositoryLock(execution.repository, async () => {
      await commitJobWorktree({ repoPath: execution.repository, runId, jobId: execution.id, message: `Task graph ${nodeKey}/${execution.key}` });
      const latest = await ensureIntegrationRef({
        repoPath: execution.repository, runId, baseRef: execution.gitRef, baseCommit: execution.baseCommit,
      });
      return integrateJobWorktree({
        repoPath: execution.repository, runId, jobId: execution.id,
        integrationRef: latest.ref, expectedIntegrationCommit: latest.commit,
        baseCommit: workspace.baseCommit,
        verify: async (staging) => { checks = await runChecks(implementOnly ? [] : config.checks, staging); },
      });
    });
    await completeExecution({
      runId, nodeKey, executionKey: execution.key, claimToken, commit: integrated.commit,
      evidence: { checks, taskRunId: result.taskRunId, integratedCommit: integrated.commit },
    });
    void postGraphParentProgress(graphRun.parentTaskId, runId,
      `${nodeKey}/${execution.key} 已集成 ${integrated.commit.slice(0, 12)}`)
      .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
    await verifyNode(runId, nodeKey);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const kind = /verification/i.test(detail) ? 'test_failed'
      : detail.includes('Merge') || detail.includes('merge') || detail.includes('conflict') ? 'integration_conflict'
      : 'dispatch_failed';
    const current = await prisma.taskGraphExecution.findUnique({ where: { id: execution.id } });
    if (current?.status === 'claimed') {
      await recordExecutionIssue({ runId, nodeKey, executionKey: execution.key, claimToken, kind, detail });
      if (current.childTaskId) await postGraphChildProgress(current.childTaskId, `issue-${claimToken}`,
        `${nodeKey}/${execution.key} 暂停，尚未完成集成和验收。\n${detail}\n后继继续等待，无需重复启动。`)
        .catch((deliveryError) => console.error('[TaskGraph] child issue delivery failed:', deliveryError));
    } else {
      console.error(`[TaskGraph] verification failed after integration ${runId}/${nodeKey}:`, error);
    }
    await refreshTaskGraphRunStatus(runId);
    const graphRun = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
    void postGraphParentProgress(graphRun.parentTaskId, runId, `${nodeKey}/${execution.key} 需要处理：${detail}`)
      .catch((deliveryError) => console.error('[TaskGraph] parent progress delivery failed:', deliveryError));
  }
}

/** One poll claims only ready work. Claimed work from a previous process is never replayed automatically. */
export async function runTaskGraphCycle() {
  for (const recovery of await startConversationRecoveries(recoverTaskGraphNodeVerification)) {
    activeVerifications.add(recovery.nodeId);
    const pending = recovery.promise.finally(() => { activeVerifications.delete(recovery.nodeId); inflight.delete(pending); });
    inflight.add(pending);
  }
  const runs = await prisma.taskGraphRun.findMany({ where: { status: { in: ['running', 'attention'] } }, select: { id: true } });
  for (const run of runs) {
    await releaseReadyNodes(run.id);
    const verifying = await prisma.taskGraphNode.findMany({
      where: { runId: run.id, status: 'verifying' }, select: { id: true, key: true },
    });
    for (const node of verifying) {
      const architectureClaim = await prisma.taskGraphEvent.findUnique({
        where: { runId_idempotencyKey: { runId: run.id,
          idempotencyKey: `node:${node.key}:architecture_claimed` } },
      });
      const architectureResult = architectureClaim && await prisma.taskGraphEvent.findUnique({
        where: { runId_idempotencyKey: { runId: run.id,
          idempotencyKey: `node:${node.key}:architecture_result` } },
      });
      if (architectureClaim && !architectureResult) {
        if (!activeVerifications.has(node.id) &&
            Date.now() - architectureClaim.createdAt.getTime() > 30 * 60_000) {
          const snapshot = await prisma.taskGraphRun.findUniqueOrThrow({
            where: { id: run.id }, select: { snapshot: true },
          });
          const policy = (snapshot.snapshot as unknown as GraphDefinition).nodes
            .find((item) => item.key === node.key)?.acceptance;
          if (policy) {
            await submitNodeVerification({ runId: run.id, nodeKey: node.key,
              actorId: policy.mode === 'agent' ? policy.reviewerId! : 'system',
              evidence: { summary: '架构复核中断或超时，需人工核对 TaskRun 后处理。',
                checks: policy.checks.map((name) => ({ name, passed: false,
                  evidence: '架构复核未形成可靠结论' })) } });
            await refreshTaskGraphRunStatus(run.id);
          }
        }
        continue;
      }
      const claim = await prisma.taskGraphEvent.findUnique({
        where: { runId_idempotencyKey: { runId: run.id, idempotencyKey: `node:${node.key}:review_claimed` } },
      });
      if (claim && !activeReviews.has(node.id) && Date.now() - claim.createdAt.getTime() > 30 * 60_000) {
        const snapshot = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id }, select: { snapshot: true } });
        const policy = (snapshot.snapshot as unknown as GraphDefinition).nodes.find((item) => item.key === node.key)?.acceptance;
        if (policy?.mode === 'agent' && policy.reviewerId) {
          await submitNodeVerification({ runId: run.id, nodeKey: node.key, actorId: policy.reviewerId,
            evidence: { summary: 'Agent 复核中断或超时，需要人工处理后重新排期。',
              checks: policy.checks.map((name) => ({ name, passed: false, evidence: '复核未形成可靠结论' })) } });
          await refreshTaskGraphRunStatus(run.id);
        }
      } else if (!claim) {
        if (!activeVerifications.has(node.id)) {
          activeVerifications.add(node.id);
          const task = verifyNode(run.id, node.key)
            .catch((error) => console.error('[TaskGraph] verification failed:', error))
            .finally(() => { activeVerifications.delete(node.id); inflight.delete(task); });
          inflight.add(task);
        }
      }
    }
    const work = await listTaskGraphWork(run.id);
    const snapshot = work.some((execution) => execution.status === 'ready')
      ? await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id }, select: { snapshot: true } }) : null;
    const blockedByIssues = snapshot ? await inspectIssueDispatch(run.id, snapshot.snapshot as unknown as GraphDefinition) : new Set<string>();
    for (const execution of work) {
      if (execution.status === 'claimed' && execution.claimToken && execution.claimedAt &&
          !activeJobs.has(execution.id)) {
        const taskRun = execution.taskRunId ? await prisma.taskRun.findUnique({
          where: { id: execution.taskRunId }, select: { status: true },
        }) : null;
        const grace = taskRun?.status === 'running' ? 4 * 60 * 60_000 : 10 * 60_000;
        if (execution.claimedAt.getTime() < Date.now() - grace) {
          const flagged = await flagStaleExecutionClaim({
            runId: run.id, nodeKey: execution.node.key, executionKey: execution.key,
            claimToken: execution.claimToken, claimedBefore: new Date(Date.now() - grace),
          });
          if (flagged) {
            await refreshTaskGraphRunStatus(run.id);
            const graphRun = await prisma.taskGraphRun.findUniqueOrThrow({
              where: { id: run.id }, select: { parentTaskId: true },
            });
            void postGraphParentProgress(graphRun.parentTaskId, run.id,
              `${execution.node.key}/${execution.key} 的执行状态不确定，已暂停。请核对 TaskRun 和 worktree 后重新排期。`)
              .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
          }
        }
      }
      if (activeJobs.size >= maxConcurrentJobs) continue;
      if (execution.status !== 'ready' || activeJobs.has(execution.id)) continue;
      if (blockedByIssues.has(execution.node.key)) continue;
      const token = randomUUID();
      const node = await claimNode(run.id, execution.node.key, token);
      if (!node) {
        const current = await prisma.taskGraphNode.findUnique({
          where: { runId_key: { runId: run.id, key: execution.node.key } }, select: { status: true },
        });
        if (current?.status !== 'claimed') continue;
      }
      const claimed = await claimExecution(run.id, execution.node.key, execution.key, token);
      if (!claimed) continue;
      activeJobs.add(execution.id);
      const task = executeJob(run.id, execution.node.key, claimed, token)
        .catch((error) => console.error('[TaskGraph] job failed:', error))
        .finally(() => { activeJobs.delete(execution.id); inflight.delete(task); });
      inflight.add(task);
    }
  }
}

export async function startTaskGraphCoordinator(signal: AbortSignal) {
  let lastCleanup = 0;
  let syncing: Promise<void> | undefined;
  let adopting: Promise<void> | undefined;
  while (!signal.aborted) {
    await runTaskGraphCycle().catch((error) => console.error('[TaskGraph] cycle failed:', error));
    if (!adopting) adopting = processPendingIssueAdoptions().catch((error) => console.error('[TaskGraph] Issue association failed:', error))
      .finally(() => { adopting = undefined; });
    if (!syncing) syncing = drainIssueSync().catch((error) => console.error('[TaskGraph] Issue outbox failed:', error))
      .finally(() => { syncing = undefined; });
    if (Date.now() - lastCleanup > 60_000) {
      lastCleanup = Date.now();
      await cleanupFinishedWorkspaces().catch((error) => console.error('[TaskGraph] workspace cleanup failed:', error));
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  await Promise.allSettled(Array.from(inflight));
  await syncing;
  await adopting;
}
