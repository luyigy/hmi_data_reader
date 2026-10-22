import { isDeepStrictEqual } from 'node:util';
import { Prisma, type TaskGraphExecution, type TaskRun } from '@prisma/client';
import { prisma } from '../prisma';
import { executionProgress, type ExecutionProgress } from './execution-progress';
import { executionRetryLimits } from './retry-limits';
import { isCompletedNodeStatus, taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from './domain';
import { observeExecutionWriter } from './phase-worker';
import type { WriterObservation } from './writer-ownership';

export type DiagnosticCategory = 'waiting_for_user' | 'waiting_dependencies' | 'eligible' | 'platform_recoverable' | 'code_defect' |
  'business_material' | 'writer_unknown' | 'budget_exhausted' | 'completed' | 'running' | 'review' | 'decision' | 'diagnostic_error';
type Fact = { state: 'verified' | 'not_verified' | 'failed'; evidence: string };
type ProgressMetric = { status: 'verified' | 'not_verified' | 'stalled'; evidence: string };
type Job = Omit<TaskGraphExecution, 'dispatchMetadata'> & { dispatchMetadata: unknown };
type Probe = { observation: WriterObservation; startedAt: string; finishedAt: string };
type BudgetKey = keyof typeof executionRetryLimits;
export type ExecutionDiagnosis = {
  id: string; key: string; category: DiagnosticCategory; action: string; owner: string;
  status: string; phase: string | null; progressState: string | null; revision: number | null;
  candidateCommit: string | null; integratedCommit: string | null; worktreePath: string | null;
  taskRun: Pick<TaskRun, 'id' | 'status' | 'updatedAt'> | null; writer: Probe | null;
  budgets: { counter: BudgetKey; used: number; limit: number; remaining: number }[];
  relevantBudget: BudgetKey | null; gates: Record<string, Fact>; automaticProgress: ProgressMetric;
  transition: { from: string; expected: string; location: string; failure: string | null };
  failure: { code: string; detail: string; action?: string; owner?: string; evidenceStatus: string; source: string; missingVerification: string[] } | null;
};

const sources = {
  cycle: 'src/lib/task-graph/coordinator.ts#runTaskGraphCycle',
  dispatch: 'src/lib/task-graph/store.ts#claimExecution',
  release: 'src/lib/task-graph/store.ts#releaseReadyNodes',
  recovery: 'src/lib/task-graph/implementation-result.ts#scheduleImplementationRecovery',
  outcome: 'src/lib/task-graph/execution-progress.ts#applyExecutionOutcomeTx',
  issue: 'src/lib/task-graph/issue-dispatch.ts#inspectIssueDispatch',
};
const unverified = (evidence: string): Fact => ({ state: 'not_verified', evidence });
const verified = (evidence: string): Fact => ({ state: 'verified', evidence });

function budgetFor(progress: ExecutionProgress): BudgetKey | null {
  const code = progress.lastFailure?.code || '';
  if (code === 'integration_stale') return 'integrationAttempts';
  if (progress.phase === 'collect_result' || ['result_incomplete', 'implementation_result_invalid', 'result_protocol_invalid'].includes(code)) return 'formatAttempts';
  if (progress.lastFailure?.owner === 'platform' || /environment|dispatch|timeout|platform/.test(code)) return 'platformAttempts';
  if (/test_failed|check_failed|in_scope_defect|architecture_failed|integration_conflict/.test(code)) return 'repairAttempts';
  return null;
}

export function diagnoseExecution(args: {
  job: Job; nodeStatus: string; dependencies: Fact; approval: Fact;
  taskRun: ExecutionDiagnosis['taskRun']; writer: Probe | null; now: Date;
}): ExecutionDiagnosis {
  const { job, nodeStatus, taskRun, writer } = args;
  const progress = executionProgress(job.dispatchMetadata);
  const failure = progress?.lastFailure;
  const relevantBudget = progress ? budgetFor(progress) : null;
  const budgets = progress ? Object.entries(executionRetryLimits).map(([counter, limit]) => {
    const key: BudgetKey = counter === 'repairAttempts' ? 'repairAttempts' : counter === 'formatAttempts' ? 'formatAttempts' : counter === 'platformAttempts' ? 'platformAttempts' : 'integrationAttempts';
    return { counter: key, used: progress[key], limit, remaining: Math.max(0, limit - progress[key]) };
  }) : [];
  const gates: Record<string, Fact> = {
    dependencies: args.dependencies, approval: args.approval,
    waitCause: failure ? unverified('账本保留结构化原因；本次只读诊断尚未核实其等待轮次归属及具体业务缺项。') : unverified('没有当前结构化等待原因；不能推断需要新的恢复审批。'),
    environment: unverified('只读检查不运行浏览器、OCR或业务检查；环境齐备尚未证明。'),
    materials: unverified('未核验任务材料、交付物及其引用合同；Agent缺项陈述不是材料确实缺失的证明。'),
    snapshotRowBinding: unverified('当前派发字段与冻结快照的对应关系见节点snapshotBinding；不能仅由快照hash推定。'),
    recoveryAuthorization: unverified('已批准范围内的普通继续不要求新的恢复审批；本命令未核验当前阶段、Writer与资源边界。'),
    writer: !writer ? unverified('未领取执行没有旧写入者接管证明。') : writer.observation.kind === 'exited'
      ? verified('实际写入者探针确认退出。') : { state: writer.observation.kind === 'unknown' ? 'not_verified' : 'failed', evidence: JSON.stringify(writer.observation) },
    issueFreshness: unverified(`${sources.issue} 的实时Issue校验未执行，因为原接口会写入状态和发通知。`),
    schedulerCapacity: unverified('独立诊断进程无法读取协调器内存activeJobs或确认空闲调度槽。'),
  };
  const result: ExecutionDiagnosis = {
    id: job.id, key: job.key, category: 'diagnostic_error', action: '平台核对执行状态。', owner: 'platform',
    status: job.status, phase: progress?.phase || null, progressState: progress?.state || null, revision: progress?.revision ?? null,
    candidateCommit: progress?.candidateCommit || null, integratedCommit: job.commit, worktreePath: job.worktreePath,
    taskRun, writer, budgets, relevantBudget, gates,
    automaticProgress: { status: 'not_verified', evidence: '依赖完成或ready状态不能证明全部环境、授权及派发条件成立。' },
    transition: { from: `${nodeStatus}/${job.status}/${progress?.state || 'legacy'}`, expected: '平台核对当前阶段', location: sources.cycle, failure: null },
    failure: failure ? { code: failure.code, detail: failure.detail, action: failure.action, owner: failure.owner,
      source: 'TaskGraphExecution.dispatchMetadata.progress.lastFailure',
      missingVerification: ['具体缺失字段或材料清单', '已核查的批准来源、文件路径或不可变包SHA', '责任方及可执行补救措施'],
      evidenceStatus: 'progress.lastFailure为保留的历史报告；仅在当前暂停状态用于故障分类，未独立验证业务缺项。' } : null,
  };
  function classify(category: DiagnosticCategory, action: string, expected: string, location: string, stalled?: string) {
    result.category = category; result.action = action;
    result.transition = { ...result.transition, expected, location, failure: stalled || null };
    if (stalled) result.automaticProgress = { status: 'stalled', evidence: stalled };
    return result;
  }
  if (isCompletedNodeStatus(nodeStatus)) return classify('completed', '保留验收证据，供下游读取。', '下游依赖释放', sources.release);
  if (args.dependencies.state !== 'verified') return classify('waiting_dependencies', '等待列出的前置节点完成；不作为本节点自身失败。', 'planned → ready', sources.release);
  if (progress?.state === 'waiting_for_user') {
    result.owner = failure ? failure.requiresUserDecision ? 'user' : 'implementer' : 'unknown';
    return classify('waiting_for_user', progress.waitingMessage || '在原话题回复，平台接回原会话。', '原话题新输入 → 原执行者下一轮', 'src/lib/task-graph/conversation-inbox.ts#reconcileConversationWaits');
  }
  if (progress?.state === 'exhausted' || job.issueKind === 'retry_exhausted') return classify('budget_exhausted', '保留计数与现场；协调器核对条件变化、无进展退避及执行边界后接续已批准工作。', '条件变化或用户输入 → admitNode', sources.outcome,
    '当前保留历史重试耗尽事实；不能据此判断已批准工作失去继续资格。');
  if (progress?.state === 'ownership_attention' || writer?.observation.kind === 'unknown') return classify('writer_unknown', '保留工作区，核对探针证据，确认旧写入者退出后才接管。', '证明原写入者已退出', 'src/lib/task-graph/phase-worker.ts#assertExecutionWriterExited',
    writer?.observation.kind === 'unknown' ? writer.observation.reason : '持久化归属状态要求平台核对。');
  if (job.status === 'claimed' && writer?.observation.kind === 'alive') {
    result.automaticProgress = { status: 'not_verified', evidence: '已领取且实际写入者存活；可能由人工恢复触发，不能据此证明无需人工的自动推进。' };
    return classify('running', '等待当前实施或平台阶段完成，监测实际工具事件。', '当前阶段 → 下一阶段', sources.cycle);
  }
  if (nodeStatus === 'awaiting_human') { result.owner = 'user'; return classify('decision', '查看节点验收证据及明确的人工作业要求。', '人工作出验收决定', 'src/lib/task-graph/store.ts#submitNodeVerification'); }
  if (job.status === 'integrated' || nodeStatus === 'verifying') return classify('review', '协调器接续架构复核与独立验收，检查复核TaskRun是否仍存活。', 'claimed+all integrated → verifying → passed', 'src/lib/task-graph/restart-recovery.ts#recoverGraphReview');
  const paused = job.status === 'attention' || progress?.state === 'waiting_decision';
  const gap = paused ? 'attention/waiting_decision由admitNode核对当前条件；本只读诊断未执行放行，不能证明已接续。' : undefined;
  if (paused && failure?.code === 'missing_business_material') return classify('business_material', '平台核验下方缺项陈述、批准的原图来源及责任方，列出已查路径和仍缺证据；不得直接要求用户补图。', '核验来源 → 补材料或纠正误报 → 恢复', sources.recovery, gap);
  if (paused && /test_failed|check_failed|in_scope_defect|architecture_failed|integration_conflict/.test(failure?.code || '')) return classify('code_defect', failure?.code === 'integration_conflict'
    ? '原实施者按受控冲突计划有限回修，保留双方提交与现场。' : '交回原实施者有限回修，重跑受影响检查。', 'repair_required → ready → claimExecution', sources.outcome, gap);
  if (paused && (failure?.requiresUserDecision === true || failure?.code === 'scope_change' || failure?.code === 'permission_required')) { result.owner = failure.owner || 'user'; return classify('decision', failure.action || '平台说明具体选项、影响和决定负责人。', '用户输入 → 继续已批准工作；新增权限仍需正式批准', sources.outcome, gap); }
  if (paused) return classify('platform_recoverable', failure?.code === 'missing_upstream_input'
    ? '平台对照已通过前置提交与固定交付物核验输入合同；条件满足后继续已批准工作。'
    : '平台核验环境及候选提交，准备措施发生变化后保留原计数接续；当前准备度未验证。', '条件核对 → admitNode → ready', sources.recovery, gap);
  if (job.status === 'claimed') return classify('platform_recoverable', '旧写入者已退出时，由协调器restart-recovery核对当前阶段和候选后接续。', '旧claim → recoverGraphExecution', 'src/lib/task-graph/restart-recovery.ts#recoverGraphExecution');
  if (job.status === 'ready' || job.status === 'planned') {
    if (progress?.nextRetryAt && Date.parse(progress.nextRetryAt) > args.now.getTime()) return classify('platform_recoverable', `等待原预算退避至${progress.nextRetryAt}，不提前重派。`, '退避到期 → claimExecution', sources.dispatch);
    return classify('eligible', '应检查协调器自动领取；实时Issue校验、extra repo锁、并发槽和环境尚未证实，不能宣称已运行。', job.status === 'planned' ? 'planned → ready → claimed' : 'ready → claimed', job.status === 'planned' ? sources.release : sources.dispatch);
  }
  return result;
}

export async function diagnoseTaskGraphRun(runId: string, db: Pick<typeof prisma, '$transaction'> = prisma,
  probe: typeof observeExecutionWriter = observeExecutionWriter) {
  const startedAt = new Date().toISOString();
  const snapshot = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const run = await tx.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, include: { nodes: { include: { executions: true }, orderBy: { key: 'asc' } } } });
    const proposal = await tx.taskGraphProposal.findUnique({ where: { parentTaskId_version: { parentTaskId: run.parentTaskId, version: run.version } }, select: { id: true, status: true, snapshotHash: true, decidedBy: true, decidedAt: true } });
    const ids = run.nodes.flatMap(node => node.executions.flatMap(job => job.taskRunId ? [job.taskRunId] : []));
    const taskRuns = await tx.taskRun.findMany({ where: { OR: [{ id: { in: ids } }, { taskId: { in: run.nodes.flatMap(node => [`task-graph-review-${node.id}`, `task-graph-architecture-${node.id}`]) } }] }, select: { id: true, taskId: true, status: true, updatedAt: true } });
    const events = await tx.$queryRaw<{ id: string; nodeId: string | null; kind: string; createdAt: Date; payload: Prisma.JsonValue }[]>`
      SELECT DISTINCT ON ("nodeId") id, "nodeId", kind, "createdAt", payload FROM "TaskGraphEvent"
      WHERE "runId" = ${runId} ORDER BY "nodeId", "createdAt" DESC, id DESC`;
    return { run, proposal, taskRuns, events, sampledAt: new Date().toISOString() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
  let approval: Fact;
  let definition: GraphDefinition | null = null;
  try {
    definition = validateTaskGraphDefinition(snapshot.run.snapshot as unknown as GraphDefinition);
    const hash = taskGraphSnapshotHash(definition);
    if (hash !== snapshot.run.snapshotHash) approval = { state: 'failed', evidence: 'Run snapshotHash与当前冻结定义不一致。' };
    else if (!snapshot.proposal) approval = unverified('未找到确认提议；历史导入授权需独立核验。');
    else if (snapshot.proposal.status === 'confirmed' && snapshot.proposal.snapshotHash === hash && snapshot.run.requestKey === `feishu-proposal:${snapshot.proposal.id}` && snapshot.proposal.decidedBy && snapshot.proposal.decidedAt)
      approval = verified(`确认提议${snapshot.proposal.id}与Run快照${hash}一致。`);
    else approval = { state: 'failed', evidence: '当前提议状态、决定记录、requestKey或hash与Run不匹配。' };
  } catch (error) { approval = { state: 'failed', evidence: error instanceof Error ? error.message : String(error) }; }
  const taskRuns = new Map(snapshot.taskRuns.map(item => [item.id, item]));
  const statuses = new Map(snapshot.run.nodes.map(node => [node.key, node.status]));
  const missingApprovedNodes = definition?.nodes.filter(node => !statuses.has(node.key)).map(node => node.key) || [];
  if (missingApprovedNodes.length) approval = { state: 'failed', evidence: `获批节点缺少物化记录：${missingApprovedNodes.join('、')}` };
  const nodes: { snapshotBinding: Fact; key: string; status: string; category: DiagnosticCategory; dependencies: { key: string; status: string }[];
    jobs: (ExecutionDiagnosis | { id: string; key: string; category: 'diagnostic_error'; action: string; error: string })[];
    latestEvent: typeof snapshot.events[number] | null; reviewTaskRuns: typeof snapshot.taskRuns; action: string }[] = [];
  for (const node of snapshot.run.nodes) {
    const frozen = definition?.nodes.find(item => item.key === node.key);
    const drift = !frozen ? ['快照中不存在当前节点'] : [
      ...(JSON.stringify([...frozen.dependsOn].sort()) !== JSON.stringify([...node.dependsOn].sort()) ? ['dependsOn'] : []),
      ...(frozen.executions.length !== node.executions.length ? ['execution count'] : []),
      ...node.executions.flatMap(job => {
        const original = frozen.executions.find(item => item.key === job.key);
        if (!original) return [`execution:${job.key}`];
        return [...(!isDeepStrictEqual(original.launchConfig ?? null, job.launchConfig) ? [`${job.key}.launchConfig`] : []), ...(['repository', 'gitRef', 'baseCommit', 'agentSelector'] as const).filter(key => original[key] !== job[key]).map(key => `${job.key}.${key}`)];
      }),
    ];
    const snapshotBinding: Fact = drift.length ? { state: 'failed', evidence: `当前派发行与冻结快照不同：${drift.join('、')}` } : verified('节点依赖与执行key/repository/gitRef/baseCommit/agentSelector与launchConfig匹配冻结快照。');
    const dependencies = node.dependsOn.map(key => ({ key, status: statuses.get(key) || 'missing' }));
    const dependencyGate: Fact = dependencies.every(item => isCompletedNodeStatus(item.status)) ? verified('所有冻结依赖节点已passed或delivered_unverified。')
      : { state: 'failed', evidence: JSON.stringify(dependencies.filter(item => !isCompletedNodeStatus(item.status))) };
    const jobs: (ExecutionDiagnosis | { id: string; key: string; category: 'diagnostic_error'; action: string; error: string })[] = [];
    for (const job of node.executions) {
      try {
        let writer: Probe | null = null;
        if (!isCompletedNodeStatus(node.status) && job.status !== 'planned' && (job.taskRunId || executionProgress(job.dispatchMetadata)?.worker)) {
          const probeStarted = new Date().toISOString();
          const observation = await probe(job).catch(error => ({ kind: 'unknown' as const, reason: `写入者探针失败：${error instanceof Error ? error.message : String(error)}` }));
          writer = { observation, startedAt: probeStarted, finishedAt: new Date().toISOString() };
        }
        const diagnosis = diagnoseExecution({ job, nodeStatus: node.status, dependencies: dependencyGate, approval, writer,
          taskRun: job.taskRunId ? taskRuns.get(job.taskRunId) || null : null, now: new Date() });
        diagnosis.gates.snapshotRowBinding = snapshotBinding;
        if ((snapshotBinding.state === 'failed' || approval.state === 'failed') && diagnosis.category === 'eligible') {
          diagnosis.category = 'diagnostic_error'; diagnosis.action = '平台核对派发行与获批快照差异，不能假定允许自动领取。';
          diagnosis.transition.failure = snapshotBinding.state === 'failed' ? snapshotBinding.evidence : approval.evidence;
        }
        jobs.push(diagnosis);
      } catch (error) { jobs.push({ id: job.id, key: job.key, category: 'diagnostic_error', action: '保留现场，修复该执行的诊断数据；其他节点继续检查。', error: error instanceof Error ? error.message : String(error) }); }
    }
    const priority: DiagnosticCategory[] = ['diagnostic_error', 'budget_exhausted', 'writer_unknown', 'decision', 'business_material', 'code_defect', 'platform_recoverable', 'waiting_for_user', 'waiting_dependencies', 'running', 'review', 'eligible', 'completed'];
    const category = priority.find(kind => jobs.some(job => job.category === kind)) || 'diagnostic_error';
    nodes.push({ snapshotBinding, key: node.key, status: node.status, category, dependencies, jobs,
      latestEvent: snapshot.events.find(event => event.nodeId === node.id) || null,
      reviewTaskRuns: snapshot.taskRuns.filter(item => item.taskId === `task-graph-review-${node.id}` || item.taskId === `task-graph-architecture-${node.id}`),
      action: jobs.find(job => job.category === category)?.action || '执行清单为空，平台检查图定义。' });
  }
  const jobs = nodes.flatMap(node => node.jobs);
  return { runId, readOnly: true, startedAt, databaseSampledAt: snapshot.sampledAt, finishedAt: new Date().toISOString(),
    consistency: '图、当前progress、TaskRun及每节点最近事件来自同一REPEATABLE READ只读事务；进程探针在事务后独立采样，不能视为原子状态。',
    categoryCounts: Object.fromEntries(Array.from(new Set(nodes.map(node => node.category))).map(category => [category, nodes.filter(node => node.category === category).length])),
    frontier: nodes.filter(node => !isCompletedNodeStatus(node.status) && node.dependencies.every(dependency => isCompletedNodeStatus(dependency.status))).map(node => node.key),
    run: { status: snapshot.run.status, version: snapshot.run.version, snapshotHash: snapshot.run.snapshotHash, parentTaskId: snapshot.run.parentTaskId },
    approval: { check: approval, proposal: snapshot.proposal, missingApprovedNodes },
    automaticProgress: { verified: jobs.filter(job => 'automaticProgress' in job && job.automaticProgress.status === 'verified').length,
      notVerified: jobs.filter(job => 'automaticProgress' in job && job.automaticProgress.status === 'not_verified').length,
      stalled: jobs.filter(job => 'automaticProgress' in job && job.automaticProgress.status === 'stalled').length,
      allConditionsSatisfied: 'not_verified', explanation: '存活写入者仅证明进行中；只读诊断不执行环境、材料、授权或实时Issue验证，不将这些未知条件推定为已满足。' }, nodes };
}
