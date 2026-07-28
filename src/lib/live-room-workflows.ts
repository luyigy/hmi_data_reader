import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { resolveLiveRoomMemberPermission } from '@/lib/live-room-permissions';
import {
  buildLiveRoomAcpxParticipant,
  extractRemoteHostIdFromRoleLabel,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
  syncLiveRoomSourceTask,
} from '@/lib/live-room';
import { prisma } from '@/lib/prisma';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type LiveRoomWorkflowName = 'feature' | 'debug';

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

const ROLE_PRIORITY = ['implementer', 'planner', 'reviewer', 'tester', 'researcher', 'custom'];

export const parseLiveRoomWorkflowCommand = (content: string) => {
  const match = content.trim().match(/^\/run\s+(feature|debug)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase() as LiveRoomWorkflowName,
    task: match[2]?.trim() || '',
  };
};

export const parseLiveRoomPlanCommand = (content: string) => {
  const match = content.trim().match(/^\/plan(?:\s+([\s\S]+))?$/i);
  if (!match?.[1]) return null;
  const tokens = match[1].trim().split(/\s+/);
  const host = tokens[0]?.startsWith('--host=') ? tokens.shift()!.slice(7) : undefined;
  const task = tokens.join(' ').trim();
  return task ? { host, task } : null;
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
  const selected = selectLiveRoomPlanHost(room.members as Array<WorkflowMember & { canReply: boolean }>, command.host);
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
      permissionConfig: resolveLiveRoomMemberPermission(member.acpxPermissionConfig, sourceTask.acpxPermissionConfig),
    });
    const stage = result.participants[0];
    const output = stage?.summary || stage?.error || `${label} 未返回结果`;
    outputs.push({ label, member: member.displayName, output });
    await postLiveRoomMessage({ roomId, senderMemberId: member.id, content: `【${label}】\n${output}`, messageType: 'assistant', replyToMessageId: sourceMessageId });
    if (stage?.status !== 'completed') throw new Error(`${member.displayName} 未完成 ${label}`);
    return output;
  };
  try {
    await runStage(host, '约束定义', '定义问题、范围、约束、风险和计划验收标准；只讨论，不写文件。');
    for (const member of participants.slice(1)) {
      await runStage(member, '成员建议', '基于全部前文给出一次建议，覆盖方案、风险、验证和待确认项；只讨论。');
    }
    const finalOutput = await runStage(host, 'PLAN 定稿', [
      '生成唯一 PLAN：先读取目标 HEAD 的 docs/workflow/workflow-contract.yaml。',
      '写入 docs/ 下合法的三位编号 PLAN 文件，包含范围、方案、风险、验证和待确认项。',
      'front matter 必须为 doc_type: PLAN、plan_kind: phase、doc_status: ready、next_action: start_first_slice，并有完整 workflow prompt。',
      '最后仅输出 PLAN_PATH: docs/<可选目录>/<filename>；由系统提交，随后由 workflow validator 校验。',
    ].join(' '));
    const planPath = planPathFrom(finalOutput);
    if (!planPath) throw new Error('主持人未返回合法 PLAN_PATH，未提交。');
    await execFileAsync('git', ['add', '--', planPath], { cwd: sourceTask.workingDirectory || process.cwd() });
    await execFileAsync('git', ['commit', '--only', '-m', `docs: add plan for ${command.task.slice(0, 48)}`, '--', planPath], { cwd: sourceTask.workingDirectory || process.cwd() });
    await postLiveRoomMessage({ roomId, content: `系统提示：PLAN 已提交：${planPath}。后续由 workflow validator 校验；不合格会自动通知 Agent 修订，合格后才发送审批卡。`, messageType: 'system' });
  } catch (error) {
    await postLiveRoomMessage({ roomId, content: `系统提示：PLAN 未提交：${error instanceof Error ? error.message : String(error)}`, messageType: 'system' });
  }
  return true;
};

const firstByRole = (members: WorkflowMember[], roles: string[], excludedIds: string[] = []) =>
  roles
    .map((role) => members.find((member) => member.role === role && !excludedIds.includes(member.id)))
    .find(Boolean)
  || members.find((member) => !excludedIds.includes(member.id))
  || members[0];

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
  members: WorkflowMember[]
) => {
  const eligible = [...members]
    .filter((member) => member.harnessType)
    .sort((left, right) => ROLE_PRIORITY.indexOf(left.role) - ROLE_PRIORITY.indexOf(right.role));
  const lead = firstByRole(eligible, ['implementer', 'planner']);
  const reviewer = firstByRole(eligible, ['reviewer'], lead ? [lead.id] : []);
  const tester = firstByRole(
    eligible,
    ['tester'],
    [lead?.id, reviewer?.id].filter((id): id is string => Boolean(id))
  );
  const stages: WorkflowStage[] = [];

  for (const member of eligible) {
    addStage(
      stages,
      `analysis-${member.id}`,
      '独立分析',
      member,
      name === 'debug'
        ? '独立分析问题，给出可能根因、证据、风险和建议排查路径。此阶段不要修改代码。'
        : '独立分析需求，给出实现建议、风险、边界和需要确认的问题。此阶段不要修改代码。'
    );
  }

  if (name === 'debug') {
    addStage(stages, 'reproduce-plan', '复现方案', tester, '根据已有分析制定最小复现步骤、回归范围和通过标准。此阶段不要修改代码。');
    addStage(stages, 'fix-plan', '修复计划', lead, '汇总已有分析和复现方案，确定根因修复计划、涉及文件和验证方式。此阶段不要修改代码。');
  } else {
    addStage(stages, 'plan', '实施计划', lead, '汇总所有分析，给出最小实施计划、涉及文件、风险和验证方式。此阶段不要修改代码。');
  }

  addStage(stages, 'plan-review', '计划审查', reviewer, '审查计划是否解决真实问题、是否遗漏边界或过度设计。明确给出 APPROVED 或 CHANGES_REQUESTED，并列出具体理由。不要修改代码。');
  addStage(stages, 'plan-final', '计划定稿', lead, '根据计划审查意见修订并输出最终实施计划。不要修改代码。');
  addStage(
    stages,
    'test-plan',
    '测试方案',
    tester,
    name === 'debug'
      ? '在修复前确定回归测试方案：复现用例、修复后通过标准、相关回归范围和具体命令。不要随意扩大测试范围，不要修改代码。'
      : '在实施前确定验收标准和测试方案：用例、预期结果、具体命令及测试边界。不要随意扩大测试范围，不要修改代码。'
  );
  addStage(
    stages,
    name === 'debug' ? 'fix' : 'implement',
    name === 'debug' ? '实施修复' : '功能实施',
    lead,
    '严格按照已确认计划和测试方案修改代码。完成最小必要实现和自测，并列出修改文件。'
  );
  addStage(stages, 'code-review', '代码审查', reviewer, '审查实际代码改动的正确性、回归风险、安全性和是否符合计划。运行必要的轻量检查。明确给出 APPROVED 或 CHANGES_REQUESTED；发现问题时给出文件和位置。');
  addStage(stages, 'test', name === 'debug' ? '回归测试' : '验收测试', tester, '严格按照前面确认的测试方案执行测试。报告实际命令、结果和失败证据，明确给出 PASSED 或 FAILED。');
  addStage(stages, 'final', '最终总结', lead, '汇总实施、代码审查和测试结果。若存在未解决失败必须明确说明，不得声称任务已完成。');

  return stages;
};

const formatPriorOutputs = (outputs: Array<{ label: string; member: string; output: string }>) =>
  outputs.map((item) => `## ${item.label} · ${item.member}\n${item.output}`).join('\n\n');

export const runLiveRoomWorkflow = async ({
  roomId,
  sourceMessageId,
  name,
  task,
}: {
  roomId: string;
  sourceMessageId: string;
  name: LiveRoomWorkflowName;
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

  const stages = buildLiveRoomWorkflowStages(name, room.members as WorkflowMember[]);
  if (!task || stages.length === 0) {
    await postLiveRoomMessage({
      roomId,
      content: task ? '系统提示：当前房间没有可执行工作流的 Agent。' : `系统提示：用法：/run ${name} <任务>`,
      messageType: 'system',
    });
    return;
  }

  await postLiveRoomMessage({
    roomId,
    content: `系统提示：${name} 工作流已启动，共 ${stages.length} 个阶段：${stages.map((stage) => stage.label).join(' → ')}`,
    messageType: 'system',
    replyToMessageId: sourceMessageId,
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: { systemEvent: 'workflow_started', workflow: name },
    }),
  });

  const outputs: Array<{ label: string; member: string; output: string }> = [];
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
    const result = await executeAcpxTaskRun({
      taskId: sourceTask.id,
      taskSessionId: sourceTask.currentTaskSession?.id || undefined,
      taskName: sourceTask.name,
      taskDescription: [
        `Live Room ${name} workflow.`,
        `Original task: ${task}`,
        `Current stage: ${stage.label}`,
        `Stage instruction: ${stage.instruction}`,
        priorOutputs ? `Confirmed prior stage outputs:\n${priorOutputs}` : '',
        'Only perform the current stage. Return its concrete result; do not start later stages or contact another agent.',
      ].filter(Boolean).join('\n\n'),
      orchestrationMode: 'staged',
      participants: [participant],
      workingDirectory: sourceTask.workingDirectory || process.cwd(),
      permissionConfig: resolveLiveRoomMemberPermission(
        stage.member.acpxPermissionConfig,
        sourceTask.acpxPermissionConfig
      ),
    });
    const stageResult = result.participants[0];
    const output = stageResult?.summary || stageResult?.error || `${stage.label} 未返回结果`;
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
          taskRunId: result.taskRunId,
          status: stageResult?.status || result.status,
        },
      }),
    });

    if (stageResult?.status !== 'completed') {
      await postLiveRoomMessage({
        roomId,
        content: `系统提示：${name} 工作流在“${stage.label}”阶段停止：${output}`,
        messageType: 'system',
        metadata: resolveLiveRoomMessageMetadata({
          senderKind: 'system',
          extras: { systemEvent: 'workflow_failed', workflow: name, stage: stage.id },
        }),
      });
      return;
    }
  }

  await postLiveRoomMessage({
    roomId,
    content: `系统提示：${name} 工作流已完成。`,
    messageType: 'system',
    metadata: resolveLiveRoomMessageMetadata({
      senderKind: 'system',
      extras: { systemEvent: 'workflow_completed', workflow: name },
    }),
  });
};
