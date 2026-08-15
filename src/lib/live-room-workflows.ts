import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import {
  buildLiveRoomAcpxParticipant,
  extractRemoteHostIdFromRoleLabel,
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { prisma } from '@/lib/prisma';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  applyWorkflowPermissionSnapshot,
  readWorkflowPermissionSnapshot,
} from '@/lib/workflow-execution-policy';
import { attachLiveRoomProgress } from '@/lib/live-room-progress';
import type { WorkflowRoleLevel } from '@/lib/scheduled-jobs/workflow-autonomy';

export type LiveRoomWorkflowName = 'feature' | 'debug';
export type LiveRoomWorkflowLevel = WorkflowRoleLevel;

const execFileAsync = promisify(execFile);

type WorkflowMember = {
  id: string;
  canReply?: boolean;
  displayName: string;
  backend: string | null;
  harnessType: string | null;
  gatewayId: string | null;
  runtimeAgentId: string | null;
  role: string;
  roleLabel: string | null;
  acpxPermissionConfig: string | null;
  codexModel: string | null;
  codexReasoningEffort: string | null;
  gateway: { id: string; name: string } | null;
};

type WorkflowStage = {
  id: string;
  label: string;
  member: WorkflowMember;
  instruction: string;
};

const WORKFLOW_ROLES = ['planner', 'implementer', 'reviewer', 'tester'] as const;

const workflowRolesFor = (level: LiveRoomWorkflowLevel, approvedPlan = false) => level === 'full'
  ? approvedPlan ? WORKFLOW_ROLES.slice(1) : WORKFLOW_ROLES
  : level === 'lean'
    ? WORKFLOW_ROLES.slice(1)
    : level === 'fast'
      ? WORKFLOW_ROLES.filter((role) => role === 'implementer' || role === 'tester')
      : WORKFLOW_ROLES.filter((role) => role === 'implementer');

export const parseLiveRoomWorkflowCommand = (content: string) => {
  const match = content.trim().match(/^\/run\s+(feature|debug)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  const tokens = (match[2] || '').trim().split(/\s+/).filter(Boolean);
  let level: LiveRoomWorkflowLevel = 'full';
  while (tokens[0]?.startsWith('--')) {
    const option = tokens.shift()!;
    const value = option.match(/^--level=(full|lean|fast|implement)$/i)?.[1]?.toLowerCase();
    if (!value) return null;
    level = value as LiveRoomWorkflowLevel;
  }

  return {
    name: match[1].toLowerCase() as LiveRoomWorkflowName,
    level,
    task: tokens.join(' '),
  };
};

export const parseLiveRoomPlanCommand = (content: string) => {
  const match = content.trim().match(/^\/plan(?:\s+([\s\S]+))?$/i);
  if (!match?.[1]) return null;
  const tokens = match[1].trim().split(/\s+/);
  let host: string | undefined;
  let revisionPath: string | undefined;
  while (tokens[0]?.startsWith('--')) {
    const option = tokens.shift()!;
    if (option.startsWith('--host=')) host = option.slice(7);
    else if (option.startsWith('--revise=')) revisionPath = option.slice(9);
    else return null;
  }
  const task = tokens.join(' ').trim();
  if (!task || (revisionPath && !planPathFrom(`PLAN_PATH: ${revisionPath}`))) return null;
  return {
    ...(host ? { host } : {}),
    ...(revisionPath ? { revisionPath } : {}),
    task,
  };
};

export const selectLiveRoomPlanHost = <T extends WorkflowMember>(members: T[], requestedHost?: string) => {
  const eligible = members.filter((member) => member.canReply && member.harnessType);
  const query = requestedHost?.trim().replace(/^[@$]/, '').toLowerCase();
  if (query) {
    const matches = eligible.filter((member) => member.id.endsWith(query)
      || member.displayName.toLowerCase() === query);
    return matches.length === 1 ? { host: matches[0] } : { error: `找不到唯一主持人：${requestedHost}` };
  }
  const planners = eligible.filter((member) => member.role === 'planner');
  return planners.length === 1
    ? { host: planners[0] }
    : { error: planners.length ? '存在多个 planner，请使用 --host=<成员> 指定主持人。' : '没有唯一 planner，请使用 --host=<成员> 指定主持人。' };
};

export const planPathFrom = (output: string) => output.match(/^PLAN_PATH:\s*(docs\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[0-9]{3}_PLAN_[^/\s]+\.md)\s*$/mi)?.[1] || null;

export const workflowPlanRevisionPathFrom = (content: string) =>
  /(?:^|\n)PLAN_REVISE\s*(?:\n|$)/.test(content)
    ? content.match(/^plan_path:\s*(docs\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[0-9]{3}_PLAN_[^/\s]+\.md)\s*$/mi)?.[1] || null
    : null;

const FILTER_DIAGNOSTIC_NOISE = /^(?:tcmalloc|jemalloc|libnuma|^\[)[\s\S]*/im;

const filterDiagnosticNoise = (text: string) => {
  const lines = text.split('\n');
  const main = lines.filter((line) => !FILTER_DIAGNOSTIC_NOISE.test(line.trim()));
  const noise = lines.filter((line) => FILTER_DIAGNOSTIC_NOISE.test(line.trim()));
  return { main: main.join('\n').trim(), noise: noise.join('\n').trim() };
};

type WorkflowPlanErrorCategory = 'member_execution' | 'plan_path' | 'git_commit' | 'unknown';

class WorkflowPlanError extends Error {
  constructor(
    message: string,
    public readonly category: WorkflowPlanErrorCategory,
    public readonly detail?: string,
    public readonly stageLabel?: string,
    public readonly memberName?: string,
  ) {
    super(message);
    this.name = 'WorkflowPlanError';
  }
}

export const runLiveRoomPlan = async ({ roomId, sourceMessageId, content }: {
  roomId: string;
  sourceMessageId: string;
  content: string;
}) => {
  const command = parseLiveRoomPlanCommand(content);
  if (!command) return false;
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: { members: { where: { canReply: true, joinStatus: 'joined' }, include: { gateway: true }, orderBy: { sortOrder: 'asc' } } },
  });
  const sourceTask = await syncLiveRoomSourceTask(roomId);
  if (!room || !sourceTask) throw new Error('Live room plan requires an active room and backing task');
  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: sourceMessageId },
    select: { metadata: true },
  });
  const workflowPermissionSnapshot = readWorkflowPermissionSnapshot(
    parseLiveRoomMessageMetadata(sourceMessage?.metadata)?.workflowPermissionSnapshot,
    sourceTask.workingDirectory || process.cwd(),
  );
  const selected = selectLiveRoomPlanHost(
    room.members as Array<WorkflowMember & { canReply: boolean }>,
    command.host || (command.revisionPath ? room.currentSpeakerMemberId || undefined : undefined),
  );
  if ('error' in selected) {
    await postLiveRoomMessage({ roomId, content: `系统提示：${selected.error}`, messageType: 'system' });
    return true;
  }
  const host = selected.host;
  const participants = [host, ...room.members.filter((member) => member.id !== host.id)] as WorkflowMember[];
  const outputs: Array<{ label: string; member: string; output: string }> = [];
  const runStage = async (member: WorkflowMember, label: string, instruction: string) => {
    const result = await executeAcpxTaskRun({
      taskId: sourceTask.id,
      taskSessionId: sourceTask.currentTaskSession?.id || undefined,
      taskName: sourceTask.name,
      taskDescription: [
        'Live Room plan discussion only. Do not implement, test, start a Slice, or restart services.',
        `Requirement: ${command.task}`,
        `Stage: ${label}. ${instruction}`,
        outputs.length ? `Prior discussion:\n${formatPriorOutputs(outputs)}` : '',
      ].filter(Boolean).join('\n\n'),
      orchestrationMode: 'staged',
      participants: [{ ...buildLiveRoomAcpxParticipant({ ...member, gatewayName: member.gateway?.name || null }), role: `plan:${label}` }],
      workingDirectory: sourceTask.workingDirectory || process.cwd(),
      permissionConfig: applyWorkflowPermissionSnapshot(
        resolveLiveRoomMemberPermission(member.acpxPermissionConfig, sourceTask.acpxPermissionConfig),
        workflowPermissionSnapshot,
      ),
    });
    const stage = result.participants[0];
    const output = stage?.summary || stage?.error || `${label} 未返回结果`;
    outputs.push({ label, member: member.displayName, output });
    await postLiveRoomMessage({ roomId, senderMemberId: member.id, content: `【${label}】\n${output}`, messageType: 'assistant', replyToMessageId: sourceMessageId });
    if (stage?.status !== 'completed') throw new WorkflowPlanError(
    `${member.displayName} 未完成 ${label}`,
    'member_execution',
    output,
    label,
    member.displayName,
  );
    return output;
  };
  try {
    await runStage(host, '约束定义', '定义问题、范围、约束、风险和计划验收标准；只讨论，不写文件。');
    for (const member of participants.slice(1)) {
      try {
        await runStage(member, '成员建议', '基于全部前文给出一次建议，覆盖方案、风险、验证和待确认项；只讨论。');
      } catch (err: any) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await postLiveRoomMessage({
          roomId,
          content: `系统提示：成员 ${member.displayName} 在建议阶段执行失败（${errorMsg}），已自动跳过该成员，由剩余成员与主持人继续生成 PLAN。`,
          messageType: 'system',
        });
      }
    }
    const finalOutput = await runStage(
      host,
      command.revisionPath ? 'PLAN 修订' : 'PLAN 定稿',
      command.revisionPath
        ? [
          '先读取目标 HEAD 的 docs/workflow/workflow-contract.yaml 和指定的现有 PLAN。',
          `只修订 ${command.revisionPath}，综合前述成员意见和审批反馈，不执行任何 Slice。`,
          `最后仅输出 PLAN_PATH: ${command.revisionPath}；由系统提交，随后由 workflow validator 复验。`,
        ].join(' ')
        : [
          '生成唯一 PLAN：先读取目标 HEAD 的 docs/workflow/workflow-contract.yaml。',
          '写入 docs/ 下合法的三位编号 PLAN 文件，包含范围、方案、风险、验证和待确认项。',
          'front matter 必须为 doc_type: PLAN、plan_kind: phase、doc_status: ready、next_action: start_first_slice，并有完整 workflow prompt。',
          '最后仅输出 PLAN_PATH: docs/<可选目录>/<filename>；由系统提交，随后由 workflow validator 校验。',
        ].join(' '),
    );
    const planPath = planPathFrom(finalOutput);
    if (!planPath) throw new WorkflowPlanError('主持人未返回合法 PLAN_PATH，未提交。', 'plan_path');
    if (command.revisionPath && planPath !== command.revisionPath) {
      throw new WorkflowPlanError(`主持人返回了其他 PLAN_PATH：${planPath}`, 'plan_path');
    }
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：PLAN 文件已生成（${planPath}），正在提交到版本库...`,
      messageType: 'system',
    });
    try {
      await execFileAsync('git', ['add', '--', planPath], { cwd: sourceTask.workingDirectory || process.cwd() });
    } catch (e: any) {
      throw new WorkflowPlanError(`git add 失败：${e?.stderr || e?.message || String(e)}`, 'git_commit');
    }
    try {
      await execFileAsync('git', [
        'commit', '--only', '-m',
        command.revisionPath ? `docs: revise ${path.basename(planPath, '.md')}` : `docs: add plan for ${command.task.slice(0, 48)}`,
        '--', planPath,
      ], { cwd: sourceTask.workingDirectory || process.cwd() });
    } catch (e: any) {
      throw new WorkflowPlanError(`git commit 失败：${e?.stderr || e?.message || String(e)}；文件已 git add（${planPath}）但未提交`, 'git_commit');
    }
    await postLiveRoomMessage({
      roomId,
      content: command.revisionPath
        ? `系统提示：PLAN 已修订并提交：${planPath}。workflow validator 将复验该提交。`
        : `系统提示：PLAN 已提交：${planPath}。后续由 workflow validator 校验；不合格会自动通知 Agent 修订，合格后才发送审批卡。`,
      messageType: 'system',
    });
  } catch (error) {
    const completedStages = outputs.length
      ? `\n已完成的阶段：${outputs.map((o) => `${o.label}（${o.member}）`).join(' → ')}`
      : '';
    let content: string;
    if (error instanceof WorkflowPlanError && error.category === 'member_execution') {
      const { main, noise } = filterDiagnosticNoise(error.detail || '');
      const detailLines = [main, noise ? `\n诊断详情（stderr）：${noise}` : ''].filter(Boolean).join('');
      content = [
        `⚠️ PLAN 编排已暂停`,
        ``,
        `失败阶段：${error.stageLabel || '未知'}（${error.memberName || '未知成员'}）`,
        `失败类型：成员执行失败`,
        `影响：PLAN 定稿尚未开始，没有文件或提交需要回滚`,
        `处置：修复执行环境后重新发起 /plan 请求`,
        completedStages,
        detailLines ? `\n${detailLines}` : '',
      ].filter(Boolean).join('\n');
    } else if (error instanceof WorkflowPlanError && error.category === 'plan_path') {
      content = [
        `⚠️ PLAN 编排已暂停`,
        ``,
        `失败类型：PLAN_PATH 不合法`,
        `原因：${error.message}`,
        `影响：没有文件或提交产生`,
        `处置：请主持人检查输出格式后重新发起 /plan`,
        completedStages,
      ].join('\n');
    } else if (error instanceof WorkflowPlanError && error.category === 'git_commit') {
      content = [
        `⚠️ PLAN 编排已暂停`,
        ``,
        `失败类型：Git 提交失败`,
        `原因：${error.message}`,
        `影响：文件可能已暂存但未提交（检查 git status）`,
        `处置：修复 Git 状态后重新发起 /plan`,
        completedStages,
      ].join('\n');
    } else {
      content = `系统提示：PLAN 未提交：${error instanceof Error ? error.message : String(error)}${completedStages}`;
    }
    await postLiveRoomMessage({ roomId, content, messageType: 'system' });
  }
  return true;
};

const addStage = (
  stages: WorkflowStage[],
  id: string,
  label: string,
  member: WorkflowMember | undefined,
  instruction: string
) => {
  if (member) {
    stages.push({ id, label, member, instruction });
  }
};

export const buildLiveRoomWorkflowStages = (
  name: LiveRoomWorkflowName,
  members: WorkflowMember[],
  level: LiveRoomWorkflowLevel = 'full',
  approvedPlan = false,
) => {
  const requiredRoles = workflowRolesFor(level, approvedPlan);
  const selected = requiredRoles.map((role) => members.find((member) => member.role === role && member.harnessType));
  if (selected.some((member) => !member) || new Set(selected.map((member) => member?.id)).size !== requiredRoles.length) {
    return [];
  }
  const planner = members.find((member) => member.role === 'planner' && member.harnessType);
  const implementer = members.find((member) => member.role === 'implementer' && member.harnessType);
  const reviewer = members.find((member) => member.role === 'reviewer' && member.harnessType);
  const tester = members.find((member) => member.role === 'tester' && member.harnessType);
  const stages: WorkflowStage[] = [];

  if (level === 'full' && !approvedPlan && name === 'debug') {
    addStage(stages, 'reproduce-plan', '复现方案', tester, '根据已有分析制定最小复现步骤、回归范围和通过标准。此阶段不要修改代码。');
    addStage(stages, 'fix-plan', '修复计划', planner, '结合复现方案确定根因修复计划、涉及文件和验证方式。此阶段不要修改代码。');
  } else if (level === 'full' && !approvedPlan) {
    addStage(stages, 'plan', '实施计划', planner, '给出最小实施计划、涉及文件、风险和验证方式。此阶段不要修改代码。');
  }

  if (level === 'full' || level === 'lean') {
    addStage(stages, 'plan-review', '计划审查', reviewer, '审查已有计划是否足以直接实施、是否遗漏边界或过度设计。明确给出 APPROVED 或 CHANGES_REQUESTED，并列出具体理由。不要修改代码。');
  }
  if (level === 'full' && !approvedPlan) {
    addStage(stages, 'plan-final', '计划定稿', planner, '根据计划审查意见修订并输出最终实施计划。不要修改代码。');
  }
  if (level === 'full') {
    addStage(
      stages,
      'test-plan',
      '测试方案',
      tester,
      name === 'debug'
        ? '在修复前确定回归测试方案：复现用例、修复后通过标准、相关回归范围和具体命令。不要随意扩大测试范围，不要修改代码。'
        : '在实施前确定验收标准和测试方案：用例、预期结果、具体命令及测试边界。不要随意扩大测试范围，不要修改代码。'
    );
  }
  addStage(
    stages,
    name === 'debug' ? 'fix' : 'implement',
    name === 'debug' ? '实施修复' : '功能实施',
    implementer,
    level === 'full'
      ? '严格按照已确认计划和测试方案修改代码。完成最小必要实现和自测，并列出修改文件。'
      : level === 'implement'
        ? '依据已有 PLAN 和原始任务直接完成最小必要实现并列出修改文件。不要重新制定计划，不要运行测试。'
        : '依据已有 PLAN 和原始任务直接完成最小必要实现与自测，并列出修改文件。不要重新制定完整计划。'
  );
  if (level === 'full') {
    addStage(stages, 'code-review', '代码审查', reviewer, '审查实际代码改动的正确性、回归风险、安全性和是否符合计划。运行必要的轻量检查。明确给出 APPROVED 或 CHANGES_REQUESTED；发现问题时给出文件和位置。');
  }
  if (level !== 'implement') {
    addStage(
      stages,
      'test',
      name === 'debug' ? '回归测试' : '验收测试',
      tester,
      level === 'full'
        ? '严格按照前面确认的测试方案执行测试。报告实际命令、结果和失败证据，明确给出 PASSED 或 FAILED。'
        : '依据已有 PLAN、原始任务和实际改动执行必要测试。报告实际命令、结果和失败证据，明确给出 PASSED 或 FAILED。',
    );
  }
  if (level === 'full' && !approvedPlan) {
    addStage(stages, 'final', '最终总结', planner, '汇总实施、代码审查和测试结果。若存在未解决失败必须明确说明，不得声称任务已完成。');
  }

  return stages;
};

export const missingLiveRoomWorkflowRoles = (
  members: WorkflowMember[],
  level: LiveRoomWorkflowLevel = 'full',
  approvedPlan = false,
) => {
  const selectedIds = new Set<string>();
  return workflowRolesFor(level, approvedPlan).filter((role) => {
    const member = members.find((candidate) => candidate.role === role
      && candidate.harnessType
      && !selectedIds.has(candidate.id));
    if (!member) return true;
    selectedIds.add(member.id);
    return false;
  });
};

export const liveRoomWorkflowGatePassed = (stageId: string, output: string) => {
  const expected = stageId === 'test'
    ? ['PASSED', 'FAILED']
    : stageId === 'plan-review' || stageId === 'code-review'
      ? ['APPROVED', 'CHANGES_REQUESTED']
      : null;
  if (!expected) return null;
  const conclusions = expected.filter((value) => new RegExp(`\\b${value}\\b`).test(output));
  return conclusions.length === 1 && conclusions[0] === expected[0];
};

const formatPriorOutputs = (outputs: Array<{ label: string; member: string; output: string }>) =>
  outputs.map((item) => `## ${item.label} · ${item.member}\n${item.output}`).join('\n\n');

export const runLiveRoomWorkflow = async ({
  roomId,
  sourceMessageId,
  name,
  level = 'full',
  approvedPlan = false,
  task,
}: {
  roomId: string;
  sourceMessageId: string;
  name: LiveRoomWorkflowName;
  level?: LiveRoomWorkflowLevel;
  approvedPlan?: boolean;
  task: string;
}) => {
  const room = await prisma.liveRoom.findUnique({
    where: { id: roomId },
    include: {
      members: {
        where: { canReply: true, joinStatus: 'joined' },
        include: { gateway: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });
  const sourceTask = await syncLiveRoomSourceTask(roomId);
  if (!room || !sourceTask) {
    throw new Error('Live room workflow requires an active room and backing task');
  }
  const sourceMessage = await prisma.liveRoomMessage.findUnique({
    where: { id: sourceMessageId },
    select: { metadata: true },
  });
  const workflowPermissionSnapshot = readWorkflowPermissionSnapshot(
    parseLiveRoomMessageMetadata(sourceMessage?.metadata)?.workflowPermissionSnapshot,
    sourceTask.workingDirectory || process.cwd(),
  );

  const members = room.members as WorkflowMember[];
  const missingRoles = missingLiveRoomWorkflowRoles(members, level, approvedPlan);
  if (!task || missingRoles.length > 0) {
    await postLiveRoomMessage({
      roomId,
      content: task
        ? `系统提示：无法启动 ${name} 工作流，缺少可执行且独立的角色：${missingRoles.join('、')}。请补齐角色并确认其 harness 可用后重试。`
        : `系统提示：用法：/run ${name} [--level=full|lean|fast|implement] <任务>`,
      messageType: 'system',
    });
    return;
  }
  const stages = buildLiveRoomWorkflowStages(name, members, level, approvedPlan);

  await postLiveRoomMessage({
    roomId,
    content: `系统提示：${name} 工作流已启动（${level}），共 ${stages.length} 个阶段：${stages.map((stage) => stage.label).join(' → ')}`,
    messageType: 'system',
    replyToMessageId: sourceMessageId,
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: { systemEvent: 'workflow_started', workflow: name, level },
    }),
  });

  const outputs: Array<{ label: string; member: string; output: string }> = [];
  const finishDispatch = (state: 'completed' | 'failed') => prisma.workflowDispatch.updateMany({
    where: { messageId: sourceMessageId, state: 'reply_queued' },
    data: { state },
  });
  const failWorkflow = async (stage: WorkflowStage, reason: string) => {
    await finishDispatch('failed');
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：${name} 工作流在“${stage.label}”阶段停止，不再等待后续角色：${reason}`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: { systemEvent: 'workflow_failed', workflow: name, stage: stage.id },
      }),
    });
  };
  let inheritedFailures: Array<{ stage: WorkflowStage; reason: string }> = [];
  const deferFailure = async (stage: WorkflowStage, reason: string, index: number) => {
    const next = stages[index + 1];
    if (!next) {
      await failWorkflow(stage, reason);
      return false;
    }
    inheritedFailures.push({ stage, reason });
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：“${stage.label}”未完成，职责已顺延给 ${next.member.displayName}；下一阶段将合并执行“${stage.label} + ${next.label}”。原因：${reason}`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        extras: { systemEvent: 'workflow_stage_deferred', workflow: name, stage: stage.id, nextStage: next.id },
      }),
    });
    return true;
  };
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    await postLiveRoomMessage({
      roomId,
      content: `系统提示：[${index + 1}/${stages.length}] ${stage.label}：${stage.member.displayName} 开始执行。`,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: stage.member.id,
        extras: { systemEvent: 'workflow_stage_started', workflow: name, stage: stage.id },
      }),
    });

    const participant = {
      ...buildLiveRoomAcpxParticipant({
        ...stage.member,
        gatewayId: stage.member.backend === 'remote_ssh'
          ? extractRemoteHostIdFromRoleLabel(stage.member.roleLabel) || stage.member.gatewayId
          : stage.member.gatewayId,
        gatewayName: stage.member.gateway?.name || null,
      }),
      role: `${name}:${stage.id}`,
    };
    const priorOutputs = formatPriorOutputs(outputs);
    const inheritedInstruction = inheritedFailures.length
      ? `Inherited failed responsibilities (complete these together with the current stage):\n${inheritedFailures.map(({ stage: failedStage, reason }) => `- ${failedStage.label}: ${failedStage.instruction}\n  Failure: ${reason}`).join('\n')}`
      : '';
    const progress = await attachLiveRoomProgress({ room, participant: stage.member, sourceMessage: sourceMessage || {} });
    const result = await executeAcpxTaskRun({
      taskId: sourceTask.id,
      taskSessionId: sourceTask.currentTaskSession?.id || undefined,
      taskName: sourceTask.name,
      taskDescription: [
        `Live Room ${name} workflow.`,
        `Original task: ${task}`,
        `Current stage: ${stage.label}`,
        `Stage instruction: ${stage.instruction}`,
        inheritedInstruction,
        priorOutputs ? `Confirmed prior stage outputs:\n${priorOutputs}` : '',
        inheritedFailures.length
          ? 'Perform the inherited responsibilities and the current stage as one combined assignment. Return concrete results for both; do not start later stages or contact another agent.'
          : 'Only perform the current stage. Return its concrete result; do not start later stages or contact another agent.',
      ].filter(Boolean).join('\n\n'),
      orchestrationMode: 'staged',
      participants: [participant],
      workingDirectory: sourceTask.workingDirectory || process.cwd(),
      permissionConfig: applyWorkflowPermissionSnapshot(
        resolveLiveRoomMemberPermission(
          stage.member.acpxPermissionConfig,
          sourceTask.acpxPermissionConfig
        ),
        workflowPermissionSnapshot,
      ),
      streamCallbacks: progress.streamCallbacks,
    }).catch((error) => error as Error);
    if (result instanceof Error) {
      const reason = result.message;
      await progress.dispose(reason, false);
      outputs.push({ label: `${stage.label}（失败）`, member: stage.member.displayName, output: reason });
      if (await deferFailure(stage, reason, index)) continue;
      return;
    }
    const stageResult = result.participants[0];
    const output = stageResult?.summary || stageResult?.error || `${stage.label} 未返回结果`;
    await progress.dispose(output, stageResult?.status === 'completed');
    outputs.push({ label: stage.label, member: stage.member.displayName, output });

    await postLiveRoomMessage({
      roomId,
      senderMemberId: stage.member.id,
      content: `【${stage.label}】\n${output}`,
      messageType: 'assistant',
      replyToMessageId: sourceMessageId,
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'assistant',
        replyToMessageId: sourceMessageId,
        extras: {
          systemEvent: 'workflow_stage_completed',
          workflow: name,
          stage: stage.id,
          executionRole: participant.role,
          taskRunId: result.taskRunId,
          status: stageResult?.status || result.status,
        },
      }),
    });

    if (stageResult?.status !== 'completed') {
      if (await deferFailure(stage, output, index)) continue;
      return;
    }
    if (liveRoomWorkflowGatePassed(stage.id, output) === false) {
      if (await deferFailure(stage, `未获得唯一通过结论：${output}`, index)) continue;
      return;
    }
    inheritedFailures = [];
  }

  await finishDispatch('completed');
  await postLiveRoomMessage({
    roomId,
    content: `系统提示：${name} 工作流已完成。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: { systemEvent: 'workflow_completed', workflow: name, level },
    }),
  });
};
