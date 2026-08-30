import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { prisma } from '@/lib/prisma';
import { parseTaskSessionMetadata, rotateTaskSession } from '@/lib/acpx/session';
import { parseGrantProfile } from '@/lib/feishu-grant';
import { sendFeishuInteractiveMessage, sendFeishuTextMessage } from '@/lib/feishu-api';
import {
  normalizeAcpxPermissionConfig,
  DEFAULT_ACPX_PERMISSION_CONFIG,
} from '@/lib/acpx/permissions';
import {
  buildTaskRoomPromptContext,
  ensureTaskChatRoom,
  postTaskRoomMessage,
  postTaskRoomSessionResetMarker,
} from '@/lib/task-room';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import { buildLiveRoomAcpxParticipant, postLiveRoomMessage } from '@/lib/live-room';
import { interruptLiveRoomMemberReplies } from '@/lib/live-room-delivery';
import {
  cancelQueuedLiveRoomMemberExecutions,
  waitForLiveRoomMemberExecutionStop,
} from '@/lib/live-room-process-registry';
import {
  getBoundLiveRoom,
  resolveRoomMemberQuery,
  type FeishuConversationContext,
} from '@/lib/feishu-live-room';

type NewSessionCommand = {
  command?: string;
  args: string[];
  options: Record<string, string>;
};

type NewSessionRisk = 'running_or_queued' | 'dirty_workspace' | 'unfinished_plan' | 'missing_handover';

const execFileAsync = promisify(execFile);
const git = async (workingDirectory: string, ...args: string[]) =>
  (await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: workingDirectory,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })).stdout.trim();

function resolveHandoverPath(input: string, workingDirectory: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const relativePath = trimmed.startsWith('docs/') ? trimmed : path.posix.join('docs', trimmed);
  const absolutePath = path.resolve(workingDirectory, relativePath);
  const relativeToWorkspace = path.relative(workingDirectory, absolutePath);
  if (relativeToWorkspace === '..'
    || relativeToWorkspace.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToWorkspace)) {
    throw new Error('handover 路径必须位于当前工作目录内。');
  }
  return {
    relativePath: relativeToWorkspace.split(path.sep).join(path.posix.sep),
    absolutePath,
  };
}

const frontmatter = (content: string) => {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!match) return {};
  const value = parse(match[1]);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
};

async function findUnfinishedPlan(workingDirectory: string) {
  // ponytail: manual rotations scan committed workflow docs; add an indexed
  // projection only if repository scale makes confirmation measurably slow.
  const files = (await git(workingDirectory, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs'))
    .split('\n')
    .filter(Boolean);
  const planPaths = files.filter((file) => /\/\d+_PLAN_\d{8}_.+\.md$/.test(`/${file}`));
  const handoverPaths = files.filter((file) => /\/\d+_HANDOVER_\d{8}_.+\.md$/.test(`/${file}`));
  const completedPlans = new Set<string>();
  for (const file of handoverPaths) {
    const metadata = frontmatter(await git(workingDirectory, 'show', `HEAD:${file}`));
    if (metadata.plan_progress === 'complete' && typeof metadata.plan === 'string') {
      completedPlans.add(metadata.plan.includes('/')
        ? metadata.plan
        : path.posix.join(path.posix.dirname(file), metadata.plan));
    }
  }
  for (const file of planPaths.reverse()) {
    const metadata = frontmatter(await git(workingDirectory, 'show', `HEAD:${file}`));
    if (Object.keys(metadata).length === 0 || metadata.doc_type !== 'PLAN' || !metadata.doc_status) {
      continue;
    }
    if (!['completed', 'superseded'].includes(String(metadata.doc_status)) && !completedPlans.has(file)) {
      return file;
    }
  }
  return null;
}

export const collectNewSessionRisks = async (args: {
  taskId: string;
  roomId: string;
  memberIds: string[];
  workingDirectory: string;
  hasCommittedHandover: boolean;
}) => {
  const [taskRuns, deliveries, status, unfinishedPlan, head] = await Promise.all([
    prisma.taskRun.count({
      where: { taskId: args.taskId, status: { in: ['pending', 'running'] } },
    }),
    prisma.liveRoomDelivery.count({
      where: {
        targetMemberId: { in: args.memberIds },
        deliveryStatus: { in: ['pending', 'running'] },
        roomMessage: { roomId: args.roomId },
      },
    }),
    git(args.workingDirectory, 'status', '--short'),
    findUnfinishedPlan(args.workingDirectory),
    git(args.workingDirectory, 'rev-parse', 'HEAD'),
  ]);
  const risks: NewSessionRisk[] = [
    ...((taskRuns || deliveries) ? ['running_or_queued' as const] : []),
    ...(status ? ['dirty_workspace' as const] : []),
    ...(unfinishedPlan ? ['unfinished_plan' as const] : []),
    ...(!args.hasCommittedHandover ? ['missing_handover' as const] : []),
  ];
  return { risks, taskRuns, deliveries, status, unfinishedPlan, head };
};

export function buildNewSessionConfirmationCard(args: {
  command: NewSessionCommand;
  requesterOpenId: string;
  chatType: 'group' | 'p2p';
  rotationKey: string;
  risks: NewSessionRisk[];
  detail: string;
}) {
  const value = {
    cmd: 'new-session-confirm',
    command: JSON.stringify(args.command),
    requesterOpenId: args.requesterOpenId,
    chatType: args.chatType,
    rotationKey: args.rotationKey,
  };
  const labels: Record<NewSessionRisk, string> = {
    running_or_queued: '存在 running / queued 工作',
    dirty_workspace: '工作区存在未提交改动',
    unfinished_plan: '存在未完成 PLAN',
    missing_handover: '未提供已提交 Handover',
  };
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '确认切换 Session' },
    },
    elements: [
      { tag: 'markdown', content: args.risks.map((risk) => `- ${labels[risk]}`).join('\n') },
      { tag: 'markdown', content: args.detail },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '生成并提交 Handover 后切换' },
            value: { ...value, decision: 'handover' },
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: '直接切换' },
            value: { ...value, decision: 'direct' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '取消' },
            value: { ...value, decision: 'cancel' },
          },
        ],
      },
    ],
  };
}

async function findGeneratedHandover(workingDirectory: string, rotationKey: string) {
  const commit = await git(
    workingDirectory,
    'log',
    '-1',
    '--format=%H',
    '--fixed-strings',
    `--grep=New-Session-Rotation: ${rotationKey}`,
    'HEAD',
  );
  if (!commit) return null;
  return (await git(workingDirectory, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit, '--', 'docs'))
    .split('\n')
    .find((file) => /_HANDOVER_\d{8}_.+\.md$/.test(file)) ?? null;
}

// The transcript quoted into an emergency rotation checkpoint may repeat contract
// automation prompt markers (for example when the previous reply echoed a
// WORKFLOW_READY prompt). Repository reference-transaction hooks reject such
// documents with PROMPT_FORBIDDEN, which makes every rotation retry fail and
// accumulate staged checkpoint files. Neutralize the exact marker strings while
// keeping the surrounding text readable.
const redactWorkflowPromptMarkers = (text: string) => text
  .replace(/<!--\s*(\S*PROMPT_(?:START|END))\s*-->/g, (_match, token: string) => `〔${token} 标记已脱敏〕`);

async function generateCommittedHandover(args: {
  workingDirectory: string;
  rotationKey: string;
  roomTitle: string;
  taskName: string;
  memberName: string;
  snapshot: Awaited<ReturnType<typeof collectNewSessionRisks>>;
  transcript: string;
}) {
  const existing = await findGeneratedHandover(args.workingDirectory, args.rotationKey);
  if (existing) return existing;
  const docsDirectory = path.join(args.workingDirectory, 'docs');
  await fs.mkdir(docsDirectory, { recursive: true });
  const numbers = (await fs.readdir(docsDirectory))
    .map((name) => Number(name.match(/^(\d{1,4})_/)?.[1] || 0))
    .filter((n) => n < 9000);
  let number = Math.max(0, ...numbers) + 1;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = createHash('sha256').update(args.rotationKey).digest('hex').slice(0, 8);
  let relativePath = '';
  while (!relativePath) {
    const candidate = `docs/${String(number).padStart(3, '0')}_HANDOVER_${date}_Session换代_${suffix}.md`;
    try {
      await fs.writeFile(path.join(args.workingDirectory, candidate), [
        '---',
        'doc_type: HANDOVER',
        'doc_status: completed',
        'next_action: none',
        'plan: null',
        'slice: null',
        'plan_progress: complete',
        '---',
        '',
        '# HANDOVER · Session 换代检查点',
        '',
        `- Room：${args.roomTitle}`,
        `- Task：${args.taskName}`,
        `- Agent：${args.memberName}`,
        `- Git HEAD：${args.snapshot.head}`,
        `- 未完成 PLAN：${args.snapshot.unfinishedPlan || '无'}`,
        '',
        '## 工作区状态',
        '',
        '```text',
        args.snapshot.status || '(clean)',
        '```',
        '',
        '## 最近上下文',
        '',
        redactWorkflowPromptMarkers(args.transcript) || '(无可用 transcript)',
        '',
        '## 下一步',
        '',
        '- 在新 Session 中先核对本文件、Git HEAD 和工作区状态，再等待用户下一条指令。',
        '',
      ].join('\n'), { encoding: 'utf8', flag: 'wx' });
      relativePath = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      number += 1;
    }
  }
  await git(args.workingDirectory, 'add', '--', relativePath);
  try {
    await git(
      args.workingDirectory,
      'commit',
      '--only',
      '-m',
      'docs(session): checkpoint before rotation',
      '-m',
      `New-Session-Rotation: ${args.rotationKey}`,
      '--',
      relativePath,
    );
  } catch (error) {
    // A rejected checkpoint (for example by an append-only guard hook) must not
    // stay written and staged, otherwise every retry mints another numbered
    // junk file while the dispatch keeps failing.
    await git(args.workingDirectory, 'restore', '--staged', '--', relativePath).catch(() => undefined);
    await fs.rm(path.join(args.workingDirectory, relativePath), { force: true }).catch(() => undefined);
    throw error;
  }
  return relativePath;
}

export async function prepareWorkflowRotationHandover(args: {
  taskId: string;
  taskName: string;
  roomId: string;
  roomTitle: string;
  workingDirectory: string;
  memberIds: string[];
  memberNames: string[];
  rotationKey: string;
  suggestedPath?: string | null;
}) {
  if (args.suggestedPath) {
    const resolved = resolveHandoverPath(args.suggestedPath, args.workingDirectory);
    if (resolved) {
      try {
        await git(args.workingDirectory, 'cat-file', '-e', `HEAD:${resolved.relativePath}`);
        return resolved.relativePath;
      } catch {
        // Fall through to an event-keyed compact checkpoint.
      }
    }
  }
  const snapshot = await collectNewSessionRisks({
    taskId: args.taskId,
    roomId: args.roomId,
    memberIds: args.memberIds,
    workingDirectory: args.workingDirectory,
    hasCommittedHandover: false,
  });
  const promptContext = await buildTaskRoomPromptContext(args.taskId, args.taskName, 30);
  return generateCommittedHandover({
    workingDirectory: args.workingDirectory,
    rotationKey: args.rotationKey,
    roomTitle: args.roomTitle,
    taskName: args.taskName,
    memberName: args.memberNames.join(', '),
    snapshot,
    transcript: promptContext.transcript,
  });
}

function buildNewSessionPrompt(args: {
  handoverPath?: string | null;
  handoverContent?: string | null;
  latestUserMessage?: string | null;
  transcript?: string | null;
  memberName: string;
  taskName: string;
  blankBootstrap?: boolean;
  initializeOnly?: boolean;
}) {
  if (args.initializeOnly) {
    return [
      `Start a fresh session for ${args.memberName} on task "${args.taskName}".`,
      args.handoverPath
        ? `Read ${args.handoverPath} as context.`
        : 'Use the supplied room/task state only as context.',
      'Briefly confirm the fresh session is ready.',
      'Do not continue the task, run tools, or modify files until the user sends a new instruction.',
      ...(args.handoverContent ? ['', 'Handover content:', args.handoverContent] : []),
      ...(!args.handoverContent && args.transcript ? ['', 'Recent task-room transcript:', args.transcript] : []),
    ].join('\n');
  }

  if (args.handoverPath && args.handoverContent) {
    return [
      `Read the handover file at ${args.handoverPath} first.`,
      'Then do exactly these three things:',
      '1. Summarize the current state.',
      '2. Confirm the next step.',
      '3. Continue the work in a fresh session.',
      '',
      'Handover content:',
      args.handoverContent,
    ].join('\n');
  }

  if (args.blankBootstrap) {
    return [
      `Start a fresh blank session for ${args.memberName} on task "${args.taskName}".`,
      'Do not assume prior room/task transcript unless the user provides it again.',
      'Wait for the next user instruction and only act on that new instruction.',
    ].join('\n');
  }

  return [
    `Start a fresh session for ${args.memberName} on task "${args.taskName}".`,
    'There is no explicit handover file for this restart.',
    'Use the current room/task state below as the bootstrap context.',
    'Then do exactly these three things:',
    '1. Summarize the current state.',
    '2. Confirm the next step.',
    '3. Continue the work in a fresh session.',
    '',
    'Latest user message:',
    args.latestUserMessage || '(none)',
    '',
    'Recent task-room transcript:',
    args.transcript || '(no transcript available)',
  ].join('\n');
}

function isTruthyFeishuOption(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

export function parseNewSessionProfile(value: string | null | undefined): 'safe_local' | 'dev_local' | 'full_access' | null {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) {
    return null;
  }

  if (['safe', 'safe_local', 'safe-local', 'local'].includes(normalized)) {
    return 'safe_local';
  }

  return parseGrantProfile(normalized);
}

function buildNewSessionPermissionConfig(
  currentPermissionConfig: ReturnType<typeof normalizeAcpxPermissionConfig>,
  requestedProfile: 'safe_local' | 'dev_local' | 'full_access' | null
) {
  if (!requestedProfile) {
    return currentPermissionConfig;
  }

  if (requestedProfile === 'safe_local') {
    return normalizeAcpxPermissionConfig({
      profile: 'safe_local',
      sandboxMode: 'workspace-write',
      networkAccess: 'restricted',
      approvalPolicy: 'never',
      writableRoots: currentPermissionConfig.writableRoots,
    });
  }

  return normalizeAcpxPermissionConfig({
    profile: requestedProfile,
    sandboxMode: requestedProfile === 'full_access' ? 'danger-full-access' : 'workspace-write',
    networkAccess: 'enabled',
    approvalPolicy: 'on-request',
    writableRoots: currentPermissionConfig.writableRoots,
  });
}

export function formatPermissionProfileLabel(profile: string) {
  return profile === 'full_access'
    ? 'Full Access'
    : profile === 'dev_local'
    ? 'Dev Local'
    : profile === 'safe_local'
    ? 'Safe Local'
    : profile;
}

export async function handleNewSessionCommand(command: NewSessionCommand, context?: FeishuConversationContext) {
  const room = await getBoundLiveRoom(context);
  if (!room || !room.sourceTask) {
    return '当前 Feishu 会话未绑定可继续的 live room / task，上下文不足，无法启动 new session。';
  }
  const sourceTask = room.sourceTask;
  const workingDirectory = room.workingDirectory || sourceTask.workingDirectory || process.cwd();

  let handoverOption = (command.options['handover'] || command.options['from-handover'] || '').trim();
  const memberQuery = (command.options['agent'] || command.args.join(' ') || '').trim();
  const allMembers = isTruthyFeishuOption(command.options['all']) || memberQuery.toLowerCase() === 'all';
  const rotatableOnly = isTruthyFeishuOption(command.options['rotatable-only']);
  const members = allMembers
    ? room.members.filter((member) =>
        member.memberType !== 'user'
        && member.canReply
        && (!rotatableOnly || member.harnessType !== 'antigravity'))
    : [resolveRoomMemberQuery({ room, query: memberQuery })].filter((member) => member !== null);
  if (!members.length) {
    return memberQuery
      ? `找不到目标成员：${memberQuery}`
      : '当前房间没有可启动 new session 的 agent 成员。';
  }
  const member = members[0];

  const confirmed = isTruthyFeishuOption(command.options['confirmed']);
  const rotationKey = command.options['rotation-key']
    || `manual:${context?.messageId || 'unknown'}:${members.map(({ id }) => id).join(',')}`;
  let handoverPath;
  try {
    handoverPath = resolveHandoverPath(handoverOption, workingDirectory);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  let handoverContent: string | null = null;
  let hasCommittedHandover = false;
  if (handoverPath) {
    try {
      await git(workingDirectory, 'cat-file', '-e', `HEAD:${handoverPath.relativePath}`);
      handoverContent = await git(workingDirectory, 'show', `HEAD:${handoverPath.relativePath}`);
      hasCommittedHandover = true;
    } catch {
      hasCommittedHandover = false;
    }
  }
  const safety = await collectNewSessionRisks({
    taskId: sourceTask.id,
    roomId: room.id,
    memberIds: members.map(({ id }) => id),
    workingDirectory,
    hasCommittedHandover,
  });
  if (!confirmed && safety.risks.length) {
    if (!context?.senderOpenId || !context.messageId) {
      return `⚠️ Session 切换需要确认：${safety.risks.join(', ')}`;
    }
    await sendFeishuInteractiveMessage({
      receiveId: context.chatId,
      receiveIdType: 'chat_id',
      replyId: context.messageId,
      card: buildNewSessionConfirmationCard({
        command,
        requesterOpenId: context.senderOpenId,
        chatType: context.chatType === 'p2p' ? 'p2p' : 'group',
        rotationKey,
        risks: safety.risks,
        detail: [
          `running：${safety.taskRuns}`,
          `queued/running delivery：${safety.deliveries}`,
          `未完成 PLAN：${safety.unfinishedPlan || '无'}`,
          `Git：${safety.status ? 'dirty' : 'clean'}`,
        ].join('\n'),
      }),
    });
    return '⚠️ 检测到 Session 切换风险，已发送确认卡；确认前不会停止运行或更换 Session。';
  }
  if (confirmed && command.options['generate-handover'] === 'true') {
    const promptContext = await buildTaskRoomPromptContext(sourceTask.id, sourceTask.name, 30);
    handoverOption = await generateCommittedHandover({
      workingDirectory,
      rotationKey,
      roomTitle: room.title,
      taskName: sourceTask.name,
      memberName: allMembers ? `全部 ${members.length} 个 agent` : member.userNickname || member.displayName,
      snapshot: safety,
      transcript: promptContext.transcript,
    });
    handoverPath = resolveHandoverPath(handoverOption, workingDirectory);
    handoverContent = await git(workingDirectory, 'show', `HEAD:${handoverPath!.relativePath}`);
  } else if (handoverOption && !hasCommittedHandover) {
    return `handover 尚未提交到当前 HEAD：${handoverPath?.relativePath || handoverOption}`;
  }
  const blankBootstrap =
    isTruthyFeishuOption(command.options['blank'])
    || isTruthyFeishuOption(command.options['no-bootstrap'])
    || isTruthyFeishuOption(command.options['no_bootstrap']);
  const participants = members.map((targetMember) => buildLiveRoomAcpxParticipant({
    id: targetMember.id,
    displayName: targetMember.displayName,
    backend: targetMember.backend,
    harnessType: targetMember.harnessType,
    gatewayId: targetMember.backend === 'remote_ssh'
      ? (targetMember.gateway?.id || targetMember.gatewayId)
      : targetMember.gatewayId,
    gatewayName: targetMember.gateway?.name || null,
    runtimeAgentId: targetMember.runtimeAgentId,
  }));
  const currentPermissionConfig = (() => {
    try {
      return normalizeAcpxPermissionConfig(
        JSON.parse(room.sourceTask.acpxPermissionConfig || 'null')
      );
    } catch {
      return DEFAULT_ACPX_PERMISSION_CONFIG;
    }
  })();
  const requestedProfile =
    parseNewSessionProfile(command.options['profile'])
    || parseNewSessionProfile(command.options['rights'])
    || parseNewSessionProfile(command.options['permission'])
    || parseNewSessionProfile(command.options['access']);
  const permissionConfig = buildNewSessionPermissionConfig(currentPermissionConfig, requestedProfile);
  let interruptedPreviousReplies = false;

  const taskRoom = await ensureTaskChatRoom(room.sourceTask.id, room.sourceTask.name);
  const promptContext = blankBootstrap
    ? { transcript: '', latestUserMessage: null }
    : await buildTaskRoomPromptContext(room.sourceTask.id, room.sourceTask.name, 30);
  let freshTaskSession = await prisma.taskSession.findFirst({
    where: {
      taskId: room.sourceTask.id,
      metadata: { contains: `"rotationKey":${JSON.stringify(rotationKey)}` },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!freshTaskSession) {
    const interruptions = await Promise.all(members.map(async (targetMember) => {
      cancelQueuedLiveRoomMemberExecutions(targetMember.id);
      return interruptLiveRoomMemberReplies({
        roomId: room.id,
        memberId: targetMember.id,
        controlAction: 'stop_run',
      });
    }));
    if (interruptions.some((interruption) => interruption.failedRunningCount > 0)) {
      return '❌ 旧 Agent 运行未能实际终止，已取消 Session 重置。请先运行 /ap sessions 查看，再用 /ap stop 重试。';
    }
    interruptedPreviousReplies = interruptions.some((interruption) =>
      interruption.interruptedRunningCount > 0 || interruption.cancelledQueuedCount > 0);
    await Promise.all(members.map((targetMember) =>
      waitForLiveRoomMemberExecutionStop(targetMember.id)));
    freshTaskSession = await rotateTaskSession(room.sourceTask.id, {
      taskName: room.sourceTask.name,
      metadata: {
        source: 'feishu_new_session',
        rotationKey,
        rotationCheckpoint: 'session_created',
        workflowEventKey: command.options['workflow-event-key'] || null,
        handoverPath: handoverPath?.relativePath || null,
        targetMemberId: allMembers ? null : member.id,
        targetMemberName: allMembers ? 'all' : member.userNickname || member.displayName,
      },
    });
  } else {
    await prisma.task.update({
      where: { id: room.sourceTask.id },
      data: { currentTaskSessionId: freshTaskSession.id },
    });
  }
  if (requestedProfile && permissionConfig.profile !== currentPermissionConfig.profile) {
    await prisma.task.update({
      where: { id: room.sourceTask.id },
      data: { acpxPermissionConfig: JSON.stringify(permissionConfig) },
    });
  }
  const resetMarker = await prisma.message.findFirst({
    where: {
      roomId: taskRoom.id,
      userId: 'system',
      content: { contains: freshTaskSession.id },
    },
    select: { id: true },
  });
  if (!resetMarker) {
    await postTaskRoomSessionResetMarker({
      roomId: taskRoom.id,
      sessionId: freshTaskSession.id,
      reason: allMembers ? 'new-session' : `new-session:${member.id}`,
    });
  }
  const liveReset = await prisma.liveRoomMessage.findFirst({
    where: {
      roomId: room.id,
      metadata: { contains: `"rotationKey":${JSON.stringify(rotationKey)}` },
    },
    select: { id: true },
  });
  if (!liveReset) {
    await postLiveRoomMessage({
      roomId: room.id,
      content: '系统提示：当前会话已重置，已启动新的 Session。',
      messageType: 'system',
      metadata: { systemEvent: 'session_reset', rotationKey },
    });
  }
  const threadedSessions = await prisma.liveRoomMemberSession.count({
    where: {
      roomId: room.id,
      memberId: { in: members.map((targetMember) => targetMember.id) },
      threadId: { not: null },
    },
  });
  if (threadedSessions) {
    await prisma.liveRoomMemberSession.updateMany({
      where: {
        roomId: room.id,
        memberId: { in: members.map((targetMember) => targetMember.id) },
        threadId: { not: null },
      },
      data: {
        threadId: null,
        status: 'online',
        lastError: 'reset_by_new_session',
        lastHeartbeatAt: new Date(),
      },
    });
  }
  await Promise.all(members.map(async (targetMember, index) => {
    const participant = participants[index];
    const targetParticipantKey = getTaskRoomParticipantTargetKey(participant);
    const targetParticipantLabel = getTaskRoomParticipantTargetLabel(participant);
    const prompt = buildNewSessionPrompt({
      handoverPath: handoverPath?.relativePath || null,
      handoverContent,
      latestUserMessage: promptContext.latestUserMessage?.content || null,
      transcript: promptContext.transcript,
      memberName: targetMember.userNickname || targetMember.displayName,
      taskName: sourceTask.name,
      blankBootstrap,
      initializeOnly: allMembers,
    });
    for (const content of [
      handoverPath
        ? `[new-session] ${targetMember.userNickname || targetMember.displayName} <- ${handoverPath.relativePath}`
        : blankBootstrap
        ? `[new-session] ${targetMember.userNickname || targetMember.displayName} <- blank bootstrap`
        : `[new-session] ${targetMember.userNickname || targetMember.displayName} <- room-state bootstrap`,
      prompt,
    ]) {
      const existing = await prisma.message.findFirst({
        where: {
          roomId: taskRoom.id,
          content,
          userId: 'task-room-user',
          targetParticipantKey,
        },
        select: { id: true },
      });
      if (!existing) {
        await postTaskRoomMessage({
          roomId: taskRoom.id,
          content,
          userId: 'task-room-user',
          userName: '用户',
          targetType: 'participant',
          targetParticipantKey,
          targetParticipantLabel,
        });
      }
    }
  }));
  const sessionMetadata = parseTaskSessionMetadata(freshTaskSession.metadata);
  if (sessionMetadata.rotationCheckpoint !== 'completed') {
    await prisma.taskSession.update({
      where: { id: freshTaskSession.id },
      data: {
        metadata: JSON.stringify({
          ...sessionMetadata,
          rotationCheckpoint: 'completed',
        }),
      },
    });
  }

  return [
    `✅ 已为 ${allMembers ? `全部 ${members.length} 个 agent` : member.userNickname || member.displayName} 重置 session`,
    `Bootstrap：${handoverPath?.relativePath ? `handover ${handoverPath.relativePath}` : blankBootstrap ? 'blank' : 'room/task state'}`,
    `请求权限：${formatPermissionProfileLabel(permissionConfig.profile)}`,
    '说明：旧运行和排队消息已停止；Agent 会在下一条真实指令到来时启动新 session。',
    ...(interruptedPreviousReplies ? ['说明：检测到并中断了未完成的旧运行或排队消息。'] : []),
  ].join('\n');
}

async function transitionWorkflowRotationFromCard(
  command: NewSessionCommand,
  from: string,
  to: string,
) {
  const projectId = command.options['workflow-project-id'];
  const jobId = command.options['workflow-job-id'];
  const eventKey = command.options['workflow-event-key'];
  if (!projectId || !jobId || !eventKey) return null;
  const claimed = await prisma.workflowDispatch.updateMany({
    where: { projectId, jobId, eventKey, state: from },
    data: { state: to },
  });
  return claimed.count > 0;
}

export async function handleNewSessionConfirmationCardAction(args: {
  value: Record<string, unknown>;
  openId: string | null;
  chatId: string | null;
  messageId?: string | null;
  onStarted?: () => void;
  asyncProcessing?: boolean;
}) {
  const decision = args.value.decision;
  if (!args.openId || !args.chatId
    || args.value.requesterOpenId !== args.openId
    || !['handover', 'direct', 'cancel'].includes(String(decision))
    || typeof args.value.command !== 'string'
    || typeof args.value.rotationKey !== 'string') {
    return { toast: { type: 'warning', content: '确认卡已失效或只能由原请求人操作' } };
  }
  let command: NewSessionCommand;
  try {
    const parsed = JSON.parse(args.value.command);
    if (!parsed || !Array.isArray(parsed.args) || !parsed.options || typeof parsed.options !== 'object') {
      throw new Error('invalid command');
    }
    command = parsed as NewSessionCommand;
  } catch {
    return { toast: { type: 'warning', content: '确认卡命令无效，请重新发送 /ap new-session' } };
  }
  if (decision === 'cancel') {
    const cancelled = await transitionWorkflowRotationFromCard(
      command,
      'rotation_confirmation_required',
      'rotation_not_required',
    );
    if (cancelled === false) {
      return { toast: { type: 'warning', content: '确认卡已处理或换代正在进行' } };
    }
    return { toast: { type: 'success', content: '已取消；未停止运行，也未切换 Session' } };
  }
  const claimed = await transitionWorkflowRotationFromCard(
    command,
    'rotation_confirmation_required',
    'rotation_pending',
  );
  if (claimed === false) {
    return { toast: { type: 'warning', content: '确认卡已处理或换代正在进行' } };
  }

  const rotationKey = String(args.value.rotationKey);

  const executeRotation = async () => {
    try {
      const result = await handleNewSessionCommand({
        ...command,
        options: {
          ...command.options,
          confirmed: 'true',
          'rotation-key': rotationKey,
          ...(decision === 'handover' ? { 'generate-handover': 'true' } : {}),
        },
      }, {
        chatId: args.chatId!,
        chatType: args.value.chatType === 'p2p' ? 'p2p' : 'group',
        senderOpenId: args.openId!,
        messageId: args.messageId || `new-session:${rotationKey}`,
      });
      await sendFeishuTextMessage({
        receiveId: args.chatId!,
        receiveIdType: 'chat_id',
        replyId: args.messageId || undefined,
        text: result,
      });
      if (result.startsWith('✅')) {
        await transitionWorkflowRotationFromCard(command, 'rotation_pending', 'rotation_completed');
      }
      return result;
    } catch (err) {
      console.error('handleNewSessionConfirmationCardAction background execution failed:', err);
      if (args.chatId) {
        void sendFeishuTextMessage({
          receiveId: args.chatId,
          receiveIdType: 'chat_id',
          replyId: args.messageId || undefined,
          text: `❌ Session 切换失败：${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => undefined);
      }
      throw err;
    }
  };

  args.onStarted?.();

  if (args.asyncProcessing) {
    void executeRotation().catch(() => undefined);
    return {
      toast: {
        type: 'success',
        content: decision === 'handover' ? '已开始生成 Handover 并切换 Session...' : '已开始切换 Session...',
      },
    };
  }

  const result = await executeRotation();
  return {
    toast: {
      type: result.startsWith('✅') ? 'success' : 'warning',
      content: result.startsWith('✅') ? 'Session 已切换' : 'Session 切换未完成，请查看回复',
    },
  };
}
