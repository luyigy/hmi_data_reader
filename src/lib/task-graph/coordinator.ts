import { applyExecutionOutcome, executionProgress, initialExecutionProgress, assertExecutionOwnership, type ExecutionOutcome } from './execution-progress';
import { prepareExtraRepositories } from './extra-repositories';
import { ServiceRuntimeError } from './attempt-services';
import { prepareUpstreamInputs, TaskInputPreparationError } from './upstream-inputs';
import { isRecord, graphRecoveryKind, latestImplementationRecovery, implementationCheckpoint, parseImplementationResult, pauseGraphImplementation, scheduleImplementationRecovery } from './implementation-result';
import { prepareAcceptanceRuntime } from './acceptance-runtime';
import { prepareGraphSpecInput } from './spec-input';
import { scheduleGraphRepair, latestGraphRepair, type ReviewDecision } from './repair';
import { graphGit } from './git-command';
import { syncGraphConversationMaterials } from './conversation-materials';
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
import { postGraphParentProgress, sendGraphHumanReviewCard } from './feishu';
import { withRepositoryLock } from './repository-lock';
import { assertReviewWorkspacesClean, resolveReviewWorkspaces } from './review-workspaces';
import {
  claimExecution, claimNode, completeExecution, completeUnverifiedNode, listTaskGraphWork, markNodeIntegrationsReady,
  recordExecutionDispatch, recordExecutionIssue,
  refreshTaskGraphRunStatus, releaseReadyNodes,
  submitNodeVerification, type VerificationEvidence,
} from './store';
import { ensureIntegrationRef, ensureJobWorktree, TaskGraphGitError, commitJobWorktree } from './worktree';
import { integrateJobWithRetry } from './integration-retry';
import { runSandboxedGraphCheck } from './check-environment';
import { executionCheckInstructions } from './execution-instructions';
import { postGraphChildProgress } from './feishu';
import { recoverGraphExecution, recoverGraphReview } from './restart-recovery';
import { requestGraphChildTopic } from './notifications';
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
export class GraphCheckError extends Error {
  constructor(readonly check: Check, readonly detail: string, readonly results: CheckResult[]) {
    super(`Verification ${check.name} failed: ${detail}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
function checkFailure(error: unknown): GraphCheckError | null {
  if (error instanceof GraphCheckError) return error;
  return error instanceof Error && 'cause' in error ? checkFailure((error as Error & { cause?: unknown }).cause) : null;
}
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
      if (error instanceof ServiceRuntimeError) throw new TaskInputPreparationError(detail, 'environment_failed', 'service_runtime');
      throw new GraphCheckError(check, detail, results);
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
  const repair = await latestGraphRepair(execution.nodeId);
  const resumed = await latestImplementationRecovery(execution.nodeId);
  const continuation = resumed && (!repair || resumed.createdAt > repair.createdAt) ? resumed : null;
  const materials = repair || continuation ? await syncGraphConversationMaterials(`task-graph-${execution.id}`) : '';
  const supplements = repair || continuation ? await prisma.liveRoomMessage.findMany({
    where: { room: { sourceTaskId: { in: [run.parentTaskId, taskId] } }, messageType: 'user' },
    orderBy: { createdAt: 'desc' }, take: 20, select: { content: true, createdAt: true },
  }) : [];
  const description = `目标：${plannedNode.goal}\n本仓交付：${plannedExecution.instructions}` +
    `\n父任务：${run.parentTaskId}\n${implementationInstructions(definition, plannedNode)}` +
    executionCheckInstructions(config.checks) + (continuation ? `\n继续原任务实施：${JSON.stringify(continuation.payload)}\n${materials}\n父子话题补充：${JSON.stringify(supplements.reverse()).slice(-12000)}\n读取保存进度和话题新材料，按原批准范围接续，不把恢复请求当作完成证据。` : '') + (repair ? `\n自动回修报告：${JSON.stringify(repair.payload)}\n${materials}\n只修当前批准范围内的问题。缺材料、权限或范围变化须明确报告，不扩大 Spec。保留旧证据，新报告写独立目录。` : '');
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

const nodeVerifications = new Map<string, Promise<void>>();
function verifyNode(runId: string, nodeKey: string, reviewAttempt?: string): Promise<void> {
  const key = `${runId}/${nodeKey}`;
  const active = nodeVerifications.get(key);
  if (active) return active;
  const pending = verifyNodeOnce(runId, nodeKey, reviewAttempt).finally(() => nodeVerifications.delete(key));
  nodeVerifications.set(key, pending);
  return pending;
}
async function verifyNodeOnce(runId: string, nodeKey: string, reviewAttempt?: string) {
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
    const upstream = await Promise.all(node.executions.map(job => prepareUpstreamInputs(job.id)));
    const upstreamPaths = Array.from(new Set(upstream.flatMap(input => input.readOnlyPaths)));
    const env = { AP_GRAPH_SERVICE_TASK_ID: `task-graph-review-${node.id}`, TASK_GRAPH_UPSTREAM_INPUTS_JSON: JSON.stringify(upstream.map(input => input.manifest)), TASK_GRAPH_REPOSITORIES_JSON: JSON.stringify(Object.fromEntries(
      workspaces.map((workspace) => [workspace.repository, workspace.path]),
    )) };
    for (const check of policy.integrationChecks || []) {
      const workspace = workspaces.slice().reverse().find((item) => item.repository === check.repository);
      if (!workspace) throw new Error(`Missing pinned repository for ${check.name}`);
      try {
        results.push(...await runChecks([check], workspace.path, { ...env, AP_PROJECT_REPOSITORY: check.repository }, [...workspaces.map((workspace) => workspace.path), ...upstreamPaths]));
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
  let reviewDecision: ReviewDecision = {};
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
    const result = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: { in: ['architecture_passed', 'architecture_failed'] } }, orderBy: { createdAt: 'desc' } });
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
    const runtime = await prepareAcceptanceRuntime(node.id, reviewAttempt || 'initial', workspaces);
    const specInput = await prepareGraphSpecInput(definition);
    await prisma.taskGraphEvent.create({ data: { runId, nodeId: node.id, idempotencyKey: claimKey + ':runtime', kind: 'acceptance_runtime_prepared', payload: { directory: runtime.directory, commits } } });
    const taskId = `task-graph-review-${node.id}`;
    const taskName = `${nodeKey} · 验收复核`;
    const task = await prisma.task.upsert({
      where: { id: taskId },
      create: { id: taskId, name: taskName, executionMode: 'acpx', status: 'pending',
        acpxParticipants: JSON.stringify([review.participant]),
        description: `独立复核任务图 ${runId} / ${nodeKey} 的交付证据。`,
        workingDirectory: runtime.directory },
      update: { workingDirectory: runtime.directory },
    });
    const supplements = await prisma.liveRoomMessage.findMany({
      where: { room: { sourceTaskId: { in: [run.parentTaskId, ...node.executions.flatMap((execution) => execution.childTaskId ? [execution.childTaskId] : [])] } }, messageType: 'user' },
      orderBy: { createdAt: 'desc' }, take: 20, select: { content: true, createdAt: true },
    });
    const materials = await Promise.all(node.executions.flatMap(job => job.childTaskId ? [syncGraphConversationMaterials(job.childTaskId)] : []));
    const prompt = `${acceptanceReviewInstructions}\n请实际验收 ${nodeKey} 的目标与证据。` +
      `\n目标：${definition.nodes.find((item) => item.key === nodeKey)?.goal}` +
      `\nSpec: ${definition.specRef}${specInput.instructions}\n固定提交组合: ${JSON.stringify(commits)}` +
      `\nIssue: ${definition.issueSource?.tickets.find((ticket) => ticket.key === nodeKey)?.ref || '历史路线，无关联'}` +
      `\n本话题用户补充材料与澄清（只作为输入，不替代验收）：${JSON.stringify(supplements.reverse()).slice(-12000)}` +
      `\n上轮验收证据（保留已通过项，补验缺口）：${JSON.stringify(node.evidence)}` +
      `\n测试运行目录（可写，仅隔离数据和报告）：${runtime.directory}` +
      `\n话题原图材料（平台获取，只读输入）：${materials.join('\n')}` +
      `\n仓库检出目录: ${JSON.stringify(workspaces)}\n证据: ${JSON.stringify(evidence)}` +
      '\n实施、测试和验收使用上述同一工作区。同仓多个任务时，最后列出的同仓目录是包含全部交付的复验结果，其余目录保留各任务原始证据。请查阅其中的原始测试产物（如 scratch 下的报告、读回 JSON 和截图），不要仅凭摘要通过。代码在验收期间只读；原仓库路径无需可读。判断路径或文件是否存在时必须直接用 pwd、ls 或 test，不得用 find 的深度限制推断不存在。' +
      '\n失败必须区分 in_scope_defect（原范围内代码或测试缺口）与 blocked_require_human（图片模糊、材料缺失、范围变化或权限越界）。缺少有效结构化结论时不会自动回修。' +
      '\n最终答复仅用一行 TASK_GRAPH_REVIEW {"approved":true或false,"note":"实际证据与理由","failureKind":"in_scope_defect 或 blocked_require_human（失败时必填）","failureKey":"本次失败的验收项完整名称"}。';
    const reviewRun = await executeAcpxTaskRun({
      taskId: task.id, taskName: task.name, taskDescription: prompt,
      orchestrationMode: 'single', participants: [review.participant],
      extraReadOnlyPaths: [...runtime.readOnlyPaths, ...specInput.paths],
      workingDirectory: task.workingDirectory || undefined,
      permissionConfig: runtime.permissionConfig,
    }).catch((error) => ({ status: 'failed', taskRunId: 'not-created',
      participants: [], summary: error instanceof Error ? error.message : String(error) }));
    const response = reviewRun.participants[0]?.summary || reviewRun.summary || '';
    const match = response.match(/TASK_GRAPH_REVIEW\s*(\{[^\r\n]+\})/);
    let decision: ReviewDecision = {};
    try { decision = match ? JSON.parse(match[1]) as typeof decision : {}; } catch { /* invalid review is a failed gate */ }
    if (reviewRun.status === 'completed') reviewDecision = decision;
    const approved = reviewRun.status === 'completed' && decision.approved === true &&
      typeof decision.note === 'string' && decision.note.trim().length > 0;
    evidence.checks = evidence.checks.map((item) => ({
      ...item, passed: item.passed && approved,
      evidence: `${item.evidence}\nAgent review ${reviewRun.taskRunId}: ${String(decision.note || response || '无有效结论')}`,
    }));
    evidence.summary = `Agent 复核 ${approved ? '通过' : '未通过'}：${String(decision.note || response || '没有有效的结构化结论')}`;
    try { await assertReviewWorkspacesClean(workspaces); } catch (error) {
      reviewDecision = {};
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
  const repairing = updated.status === 'attention' && await scheduleGraphRepair(runId, nodeKey, reviewDecision, evidence);
  if (updated.status === 'passed') {
    await cleanupCompletedNodeWorkspaces(runId, nodeKey);
    await releaseReadyNodes(runId);
  }
  if (updated.status === 'awaiting_human') {
    void sendGraphHumanReviewCard(runId, nodeKey)
      .catch((error) => console.error('[TaskGraph] human review card failed:', error));
  }
  await refreshTaskGraphRunStatus(runId);
  const outcome = repairing ? '发现原范围内缺口，已自动交回实施者；修复后接着验收。' : updated.status === 'passed' ? '验收通过，Slice 已完成；符合条件的后继将自动启动。'
    : updated.status === 'awaiting_human' ? '自动检查已结束，等待已配置的人工验收。'
    : reviewDecision.failureKind === 'in_scope_defect' ? '自动回修已停止或达到两轮上限，保留各轮报告，需核对后处理；后继继续等待。'
    : reviewDecision.failureKind === 'blocked_require_human' ? '需补材料、裁定范围或权限；原因见复核结论。补齐后在这里说继续验收即可。'
    : '验收未通过，结论尚不足以自动回修；后继继续等待。';
  await Promise.all(node.executions.flatMap((execution) => execution.childTaskId ? [
    postGraphChildProgress(execution.childTaskId, `verification-${updated.id}-${updated.updatedAt.getTime()}`,
      `${nodeKey}：${outcome}\n${evidence.summary}`)
      .catch((error) => console.error('[TaskGraph] child verification delivery failed:', error)),
  ] : []));
  const parent = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
  void postGraphParentProgress(parent.parentTaskId, runId, `${nodeKey}：${repairing ? '自动回修中' : updated.status}`)
    .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
}

export async function recoverTaskGraphNode(runId: string, nodeKey: string, recoveryKind: 'implementation' | 'verification', requestId: string) {
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } } });
  try {
    const actual = await graphRecoveryKind(node.id);
    if (actual !== recoveryKind) throw new Error('恢复阶段已改变，请根据当前阻塞重新继续');
    if (recoveryKind === 'implementation') {
      await scheduleImplementationRecovery(runId, nodeKey, requestId);
      return;
    }
    await recoverTaskGraphNodeVerification(runId, nodeKey);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
    const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id }, select: { childTaskId: true } });
    const message = `${nodeKey} 暂未接续：${detail}。保留原任务与证据，后继继续等待。`;
    await Promise.allSettled([postGraphParentProgress(run.parentTaskId, runId, message), ...jobs.flatMap(job => job.childTaskId
      ? [postGraphChildProgress(job.childTaskId, `recovery-failed-${requestId}`, message)] : [])]);
    throw error;
  }
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
  const repair = await latestGraphRepair(execution.nodeId);
  const continuation = await latestImplementationRecovery(execution.nodeId);
  const persisted = executionProgress(execution.dispatchMetadata);
  const checkpoint = persisted?.candidateCommit && persisted.workspaceBase
    ? { checkpointCommit: persisted.candidateCommit, workspaceBase: persisted.workspaceBase }
    : continuation && (!repair || continuation.createdAt > repair.createdAt)
      ? implementationCheckpoint(continuation.payload, execution.id) : null;
  const outcome = async (result: ExecutionOutcome) => {
    const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const progress = executionProgress(current.dispatchMetadata) || initialExecutionProgress();
    return applyExecutionOutcome({ executionId: execution.id, claimToken, expectedRevision: progress.revision,
      outcomeId: `${claimToken}:${progress.revision}:${result.kind}`, outcome: result });
  };
  try {
    const { integration, workspace } = await withRepositoryLock(execution.repository, async () => {
      await assertExecutionOwnership(execution.id, claimToken);
      const integration = await ensureIntegrationRef({
        repoPath: execution.repository, runId, baseRef: execution.gitRef, baseCommit: execution.baseCommit,
      });
      let workspaceBase = integration.commit;
      if (repair && !checkpoint && execution.worktreePath) {
        // Dirty repairs keep their original baseline; final integration merges and checks the latest ref.
        if (!await graphGit(execution.worktreePath, 'status', '--porcelain', '--untracked-files=all')) {
          await graphGit(execution.worktreePath, 'merge', '--ff-only', integration.commit);
        } else workspaceBase = execution.baseCommit;
      }
      let resumeCommit = checkpoint?.checkpointCommit;
      if (persisted && checkpoint && execution.worktreeBranch) {
        let exists = true;
        try { await graphGit(execution.repository, 'show-ref', '--verify', '--quiet', execution.worktreeBranch); }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 1) exists = false; else throw error; }
        if (exists) {
          const tip = await graphGit(execution.repository, 'rev-parse', execution.worktreeBranch);
          await graphGit(execution.repository, 'merge-base', '--is-ancestor', checkpoint.checkpointCommit, tip);
          resumeCommit = tip;
        }
      }
      const workspace = await ensureJobWorktree({
        repoPath: execution.repository, runId, jobId: execution.id,
        baseRef: integration.ref, baseCommit: checkpoint?.workspaceBase || workspaceBase,
        ...(resumeCommit ? { resumeCommit } : {}),
      });
      return { integration, workspace };
    });
    await assertExecutionOwnership(execution.id, claimToken);
    const implementationBase = await graphGit(workspace.path, 'rev-parse', 'HEAD');
    const { task, room } = await createChildTask(runId, nodeKey, execution, workspace.path);
    await recordExecutionDispatch({
      runId, nodeKey, executionKey: execution.key, claimToken,
      childTaskId: task.id, worktreePath: workspace.path, worktreeBranch: workspace.branch,
      dispatchMetadata: execution.dispatchMetadata ? undefined : { integrationRef: integration.ref, workspaceBase: workspace.baseCommit, ...(checkpoint ? { resumedFrom: checkpoint.checkpointCommit, attemptId: continuation?.id } : {}) },
    });
    await outcome({ kind: 'checkpoint', phase: persisted?.phase || 'implement', workspaceBase: workspace.baseCommit, candidateCommit: implementationBase });
    const graphRun = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
    const snapshot = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { snapshot: true } });
    const definition = snapshot.snapshot as unknown as GraphDefinition;
    const specInput = await prepareGraphSpecInput(definition);
    const implementOnly = definition.nodes.find((node) => node.key === nodeKey)?.executionMode === 'implement';
    await requestGraphChildTopic({
      parentTaskId: graphRun.parentTaskId, executionId: execution.id, childTaskId: task.id,
      title: task.name, workingDirectory: workspace.path,
    });
    const inputs = await prepareUpstreamInputs(execution.id);
    void postGraphParentProgress(graphRun.parentTaskId, runId,
      `${nodeKey}/${execution.key} 已启动。详细进度同步到仓库绑定群中的「${task.name}」子话题；投递期间记录仍保存在任务账本。`)
      .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
    await postTaskRoomMessage({
      roomId: room.id, userId: 'task-graph', userName: '任务图调度器',
      content: `执行 ${nodeKey}/${execution.key}。基线 ${integration.commit}。请在此 worktree 编辑代码并报告结果；平台负责受控提交，不要自行运行 git add/commit/merge。`,
    });
    const beforeRun = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const progress = executionProgress(beforeRun.dispatchMetadata)!;
    const recoveryInstructions = progress.phase === 'collect_result'
      ? '\n仅补收已有成果的 TASK_GRAPH_IMPLEMENTATION 结论，不重新实施或修改源码。不得合成没有证据的交付。'
      : progress.lastFailure ? `\n本票自动回修：${JSON.stringify(progress.lastFailure)}\n使用保留的当前源码修复上述故障，并重新运行相同检查。` : '';
    const storedRun = ['check', 'integrate'].includes(progress.phase) && progress.taskRunId
      ? await prisma.taskRun.findUnique({ where: { id: progress.taskRunId }, include: { participants: true } }) : null;
    if (storedRun && storedRun.status !== 'completed') throw new Error('Previous implementation TaskRun has no completed result');
    const result = storedRun ? { taskRunId: storedRun.id, status: storedRun.status, summary: storedRun.summary, participants: storedRun.participants } : await executeAcpxTaskRun({
      graphExecution: { executionId: execution.id, claimToken, revision: progress.revision },
      taskId: task.id, taskName: task.name, taskDescription: (task.description || '') + specInput.instructions + inputs.instructions + recoveryInstructions,
      extraReadOnlyPaths: [...specInput.paths, ...inputs.readOnlyPaths],
      orchestrationMode: 'single', participants: [config.participant], workingDirectory: workspace.path,
    });
    await recordExecutionDispatch({ runId, nodeKey, executionKey: execution.key, claimToken, taskRunId: result.taskRunId });
    const extra = await prepareExtraRepositories(definition.nodes.find(node => node.key === nodeKey)?.extraRepositories);
    const extraRepositoryState = await Promise.all(extra.details.map(async repo => ({ ...repo, workingTreeStatus: (await graphGit(repo.repository, 'status', '--porcelain', '--untracked-files=all')).slice(0, 8000) })));
    if (extraRepositoryState.length) await prisma.taskGraphEvent.create({ data: { runId, nodeId: execution.nodeId,
      idempotencyKey: `execution:${execution.id}:extra-repos:${claimToken}`, kind: 'extra_repository_state', payload: { executionId: execution.id, taskRunId: result.taskRunId, repositories: extraRepositoryState } } });
    if (result.status !== 'completed') {
      const serviceFailure = await prisma.taskGraphEvent.findFirst({ where: { nodeId: execution.nodeId, kind: 'service_attempt_failed', payload: { path: ['taskRunId'], equals: result.taskRunId } } });
      if (serviceFailure) throw new TaskInputPreparationError('临时联调服务启动或运行失败，见本次服务回执；不是业务材料缺失', 'environment_failed', 'service_runtime');
      throw new Error(`Agent execution ended: ${result.status}: ${result.summary}`);
    }
    const candidate = await withRepositoryLock(execution.repository, async () => {
      await assertExecutionOwnership(execution.id, claimToken);
      return commitJobWorktree({
        repoPath: execution.repository, runId, jobId: execution.id, message: `Task graph candidate ${nodeKey}/${execution.key}`,
      });
    });
    await outcome({ kind: 'checkpoint', phase: progress.phase === 'collect_result' ? 'collect_result' : 'implement', candidateCommit: candidate, workspaceBase: workspace.baseCommit });
    let conclusion;
    try { conclusion = parseImplementationResult(result.participants[0]?.summary || result.summary || ''); }
    catch (error) { conclusion = { status: 'invalid' as const, blockerKind: 'invalid_result' as const, note: error instanceof Error ? error.message : String(error) }; }
    if (conclusion.status !== 'delivered') {
      if (conclusion.status === 'invalid') {
        await outcome({ kind: 'result_incomplete', failure: { code: 'invalid_result', detail: conclusion.note } });
      } else {
        await pauseGraphImplementation({ runId, nodeKey, executionId: execution.id, claimToken,
          checkpointCommit: candidate, workspaceBase: workspace.baseCommit, taskRunId: result.taskRunId, result: conclusion });
      }
      await refreshTaskGraphRunStatus(runId);
      void postGraphChildProgress(task.id, `implementation-outcome-${claimToken}`,
        conclusion.status === 'invalid' ? '实施成果已保存，自动补收交付结论；尚未交付。' : `实施暂停，尚未交付：${conclusion.note}`)
        .catch(error => console.error('[TaskGraph] outcome delivery failed:', error));
      return;
    }
    await outcome({ kind: 'checkpoint', phase: 'integrate' });
    let checks: CheckResult[] = [];
    const latest = await withRepositoryLock(execution.repository, async () => {
      await assertExecutionOwnership(execution.id, claimToken);
      return ensureIntegrationRef({ repoPath: execution.repository, runId, baseRef: execution.gitRef, baseCommit: execution.baseCommit });
    });
    const beforeIntegration = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } })).dispatchMetadata);
    const integrated = await integrateJobWithRetry({
      repoPath: execution.repository, runId, jobId: execution.id,
      integrationRef: latest.ref, expectedIntegrationCommit: latest.commit, baseCommit: workspace.baseCommit,
      maxAttempts: Math.max(1, 3 - (beforeIntegration?.integrationAttempts || 0)),
      assertOwnership: async () => { await assertExecutionOwnership(execution.id, claimToken); },
      onRetry: async (failure) => {
        await outcome({ kind: 'checkpoint', phase: 'integrate', candidateCommit: await graphGit(workspace.path, 'rev-parse', 'HEAD') });
        await outcome({ kind: 'integration_stale', failure: { code: 'integration_stale', detail: JSON.stringify(failure.integration) } });
      },
      verify: async (staging) => { checks = await runChecks(implementOnly ? [] : config.checks, staging, { ...inputs.env, AP_GRAPH_SERVICE_TASK_ID: task.id }, inputs.readOnlyPaths); },
    });
    await outcome({ kind: 'integrated', commit: integrated.commit,
      evidence: { checks, implementation: conclusion, extraRepositories: extraRepositoryState, taskRunId: result.taskRunId, integratedCommit: integrated.commit },
    });
    void postGraphParentProgress(graphRun.parentTaskId, runId,
      `${nodeKey}/${execution.key} 已集成 ${integrated.commit.slice(0, 12)}`)
      .catch((error) => console.error('[TaskGraph] parent progress delivery failed:', error));
    await verifyNode(runId, nodeKey, checkpoint ? `continuation:${claimToken}` : repair ? `repair:${repair.id}` : undefined);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const kind = error instanceof TaskInputPreparationError ? 'input_preparation_failed'
      : error instanceof TaskGraphGitError ? error.code : checkFailure(error) ? 'test_failed' : 'dispatch_failed';
    const current = await prisma.taskGraphExecution.findUnique({ where: { id: execution.id } });
    if (current?.status === 'claimed') {
      if (error instanceof TaskInputPreparationError && current.worktreePath) {
        const checkpointCommit = await withRepositoryLock(execution.repository, async () => {
          await assertExecutionOwnership(execution.id, claimToken);
          return commitJobWorktree({
            repoPath: execution.repository, runId, jobId: execution.id, message: `Input preparation checkpoint ${nodeKey}/${execution.key}`,
          });
        });
        await pauseGraphImplementation({ runId, nodeKey, executionId: execution.id, claimToken, checkpointCommit,
          workspaceBase: isRecord(current.dispatchMetadata) && typeof current.dispatchMetadata.workspaceBase === 'string' ? current.dispatchMetadata.workspaceBase : execution.baseCommit,
          taskRunId: current.taskRunId || 'not-created', blockedPhase: error.blockedPhase,
          result: { status: 'blocked', blockerKind: error.blockerKind, note: detail } });
      } else {
        const failedCheck = checkFailure(error);
        if (failedCheck) {
          await assertExecutionOwnership(execution.id, claimToken);
          const candidateCommit = await withRepositoryLock(execution.repository, async () => {
            await assertExecutionOwnership(execution.id, claimToken);
            return commitJobWorktree({
              repoPath: execution.repository, runId, jobId: execution.id, message: `Checked candidate ${nodeKey}/${execution.key}`,
            });
          });
          await outcome({ kind: 'checkpoint', phase: 'check', candidateCommit });
          await outcome({ kind: 'repair_required', failure: {
          code: 'test_failed', checkId: `execution:${execution.key}:${failedCheck.check.name}`,
          command: failedCheck.check.argv, detail: failedCheck.detail,
        } });
        } else if (error instanceof TaskGraphGitError) {
          const failure = { code: error.integration?.kind === 'ownership_mismatch' ? 'ownership_mismatch' : error.code,
            detail: error.integration ? JSON.stringify({ message: detail, integration: error.integration }) : detail };
          await outcome({ kind: error.code === 'integration_retry_exhausted' ? 'retry_exhausted' : 'decision_required', failure });
        } else {
          const temporary = error instanceof Error && 'code' in error && ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(String(error.code));
          await outcome({ kind: temporary ? 'platform_retry' : 'decision_required', failure: { code: kind, detail } });
        }
      }
      const latest = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
      const progress = executionProgress(latest.dispatchMetadata);
      const state = latest.status === 'ready' ? '正在自动修复或重试，无需人工继续。'
        : progress?.state === 'exhausted' ? '自动处理已达上限，保留现场和失败证据。'
        : '需要处理一项具体决定，原因见下方详情。';
      if (current.childTaskId) await postGraphChildProgress(current.childTaskId, `issue-${claimToken}`,
        `${nodeKey}/${execution.key}：${state}\n${detail}`)
        .catch((deliveryError) => console.error('[TaskGraph] child issue delivery failed:', deliveryError));
    } else {
      console.error(`[TaskGraph] verification failed after integration ${runId}/${nodeKey}:`, error);
    }
    await refreshTaskGraphRunStatus(runId);
    const graphRun = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, select: { parentTaskId: true } });
    const finalJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const finalProgress = executionProgress(finalJob.dispatchMetadata);
    const status = finalJob.status === 'ready' ? '正在自动修复或重试，无需人工继续。'
      : finalProgress?.state === 'exhausted' ? '自动处理已达上限，现场已保留。'
      : '需要处理一项具体决定。';
    void postGraphParentProgress(graphRun.parentTaskId, runId, `${nodeKey}/${execution.key}：${status}详情见仓库群原任务话题。`)
      .catch((deliveryError) => console.error('[TaskGraph] parent progress delivery failed:', deliveryError));
  }
}

/** Prior writers retain ownership until their actual exit is proven. */
export async function runTaskGraphCycle() {
  for (const recovery of await startConversationRecoveries(recoverTaskGraphNode)) {
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
      if (activeVerifications.has(node.id) || activeReviews.has(node.id)) continue;
      const pickup = await recoverGraphReview(node.id);
      if (pickup === 'waiting') continue;
      activeVerifications.add(node.id);
      const task = verifyNode(run.id, node.key)
        .catch((error) => console.error('[TaskGraph] verification failed:', error))
        .finally(() => { activeVerifications.delete(node.id); inflight.delete(task); });
      inflight.add(task);
    }
    const work = await listTaskGraphWork(run.id);
    const snapshot = work.some((execution) => execution.status === 'ready')
      ? await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id }, select: { snapshot: true } }) : null;
    const blockedByIssues = snapshot ? await inspectIssueDispatch(run.id, snapshot.snapshot as unknown as GraphDefinition) : new Set<string>();
    for (const execution of work) {
      if (execution.status === 'claimed' && execution.claimToken && execution.claimedAt &&
          !activeJobs.has(execution.id)) {
        await recoverGraphExecution(execution.id);
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
