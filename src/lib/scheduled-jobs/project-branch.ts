import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { prisma } from '../prisma';
import {
  findProjectById,
  loadProjectsConfig,
  type ProjectConfig,
} from './project-config';
import { isFeishuAdmin } from '../feishu-access-approval';
import { sendFeishuInteractiveMessage } from '../feishu-api';

const execFileAsync = promisify(execFile);

const configFile = () => path.join(process.cwd(), 'config/projects.yaml');
const workflowJob = (project: ProjectConfig) => {
  const jobs = project.jobs.filter(({ type }) => type === 'workflow_watcher');
  if (jobs.length !== 1) throw new Error(`项目 ${project.id} 必须唯一配置 workflow-watcher。`);
  return jobs[0];
};

const cleanBranchName = (branchOrRef: string) => branchOrRef.trim().replace(/^refs\/heads\//, '');

const singleDirectory = (value: string, label: string) => {
  const directory = value.trim();
  if (!directory || directory === '..' || directory.includes('/') || directory.includes('\\')) {
    throw new Error(`${label} 必须是单层目录名或 .。`);
  }
  return directory;
};

export type ProjectBranchTarget = {
  targetBranch: string;
  targetRef: string;
  branchSpace: string;
  watchRoot: string;
};

export async function inspectProjectBranchTarget(
  project: ProjectConfig,
  newBranchOrRef: string,
  requestedBranchSpace?: string,
): Promise<ProjectBranchTarget> {
  const targetBranch = cleanBranchName(newBranchOrRef);
  if (!targetBranch) throw new Error('分支名称不能为空。');
  const targetRef = `refs/heads/${targetBranch}`;
  await execFileAsync('git', ['-C', project.path, 'check-ref-format', targetRef])
    .catch(() => { throw new Error(`目标分支名无效：${targetBranch}`); });
  await execFileAsync('git', ['-C', project.path, 'rev-parse', '--verify', `${targetRef}^{commit}`])
    .catch(() => { throw new Error(`目标分支不存在：${targetBranch}`); });

  const job = workflowJob(project);
  const contractPath = String(job.config.contract_path || '');
  if (!contractPath || path.posix.isAbsolute(contractPath) || contractPath.split('/').includes('..')) {
    throw new Error('workflow_watcher contract_path 无效。');
  }
  const contract = await execFileAsync(
    'git', ['-C', project.path, 'show', `${targetRef}:${contractPath}`], { encoding: 'utf8' },
  ).catch(() => { throw new Error(`目标分支缺少 workflow contract：${contractPath}`); });
  const branchRoot = parseDocument(contract.stdout).getIn(['branch_spaces', 'root']);
  if (typeof branchRoot !== 'string' || !branchRoot.trim()
    || path.posix.isAbsolute(branchRoot) || branchRoot.split('/').includes('..')) {
    throw new Error('目标分支 workflow contract 的 branch_spaces.root 无效。');
  }

  const branchSpace = singleDirectory(
    requestedBranchSpace || targetBranch.split('/').at(-1) || '',
    'branch_space',
  );
  const watchRoot = path.posix.join(branchRoot, branchSpace);
  const targetType = await execFileAsync(
    'git', ['-C', project.path, 'cat-file', '-t', `${targetRef}:${watchRoot}`], { encoding: 'utf8' },
  ).catch(() => null);
  if (targetType?.stdout.trim() !== 'tree') {
      throw new Error(
        `目标分支尚未提交 branch_space：${watchRoot}。请先在该目录提交首个 PLAN/HANDOVER，再重新申请。`,
      );
  }
  return { targetBranch, targetRef, branchSpace, watchRoot };
}

export async function assertProjectBranchSwitchReady(project: ProjectConfig) {
  const job = workflowJob(project);
  const [running, state] = await Promise.all([
    prisma.scheduledJobRun.count({ where: { projectId: project.id, jobId: job.id, status: 'running' } }),
    prisma.scheduledJobState.findUnique({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      select: { cursorJson: true },
    }),
  ]);
  if (running) throw new Error('workflow-watcher 正在运行，请稍后重试。');
  const cursor = state?.cursorJson;
  if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    && (cursor as { pending?: unknown }).pending) {
    throw new Error('workflow-watcher 仍有 pending；请先完成或执行 `/ap job cursor workflow-watcher --clear-pending`。');
  }
}

export type ProjectBranchInfo = {
  projectId: string;
  projectName: string;
  projectPath: string;
  monitoredRef: string;
  monitoredBranch: string;
  actualBranch: string;
  isDrifted: boolean;
  headCommit: string;
  isDetached: boolean;
};

/**
 * Inspect git repository branch at projectPath and compare against monitoredRef
 */
export async function inspectProjectBranch(
  projectPath: string,
  monitoredRef: string,
): Promise<ProjectBranchInfo> {
  const monitoredBranch = monitoredRef.replace(/^refs\/heads\//, '');
  let actualBranch = '';
  let headCommit = '';
  let isDetached = false;

  try {
    const branchRes = await execFileAsync(
      'git',
      ['-C', projectPath, 'symbolic-ref', '--short', 'HEAD'],
      { encoding: 'utf8' },
    );
    actualBranch = branchRes.stdout.trim();
  } catch {
    try {
      const revRes = await execFileAsync(
        'git',
        ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding: 'utf8' },
      );
      actualBranch = revRes.stdout.trim();
      if (actualBranch === 'HEAD') {
        isDetached = true;
      }
    } catch {
      actualBranch = 'unknown';
    }
  }

  try {
    const headRes = await execFileAsync(
      'git',
      ['-C', projectPath, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    );
    headCommit = headRes.stdout.trim();
  } catch {
    headCommit = 'unknown';
  }

  const isDrifted = !isDetached && actualBranch !== 'unknown' && actualBranch !== monitoredBranch;

  return {
    projectId: '',
    projectName: '',
    projectPath,
    monitoredRef,
    monitoredBranch,
    actualBranch,
    isDrifted,
    headCommit,
    isDetached,
  };
}

/**
 * Update monitored ref in config/projects.yaml atomically
 */
export async function updateProjectMonitoredBranch(
  projectId: string,
  newBranchOrRef: string,
  branchSpace: string,
  file = configFile(),
): Promise<{ success: boolean; newRef: string; branchSpace: string }> {
  const cleanBranch = cleanBranchName(newBranchOrRef);
  if (!cleanBranch) {
    throw new Error('分支名称不能为空。');
  }
  const newRef = `refs/heads/${cleanBranch}`;
  const newBranchSpace = singleDirectory(branchSpace, 'branch_space');

  const mode = (await fs.stat(file)).mode & 0o777;
  const document = parseDocument(await fs.readFile(file, 'utf8'));
  const projects = document.get('projects') as { items?: Array<{ get(key: string): unknown; set(key: string, val: unknown): void }> };
  const projectIndex = projects?.items?.findIndex((item) => item.get('id') === projectId) ?? -1;

  if (projectIndex < 0) {
    throw new Error(`未在 config/projects.yaml 中找到项目 ${projectId}`);
  }

  const projectNode = projects?.items?.[projectIndex];
  if (projectNode) {
    const jobs = projectNode.get('jobs') as { items?: Array<{ get(key: string): unknown }> };
    const watcherIndexes = jobs?.items
      ?.map((item, index) => item.get('type') === 'workflow_watcher' ? index : -1)
      .filter((index) => index >= 0) ?? [];
    if (watcherIndexes.length !== 1) {
      throw new Error(`项目 ${projectId} 必须唯一配置 workflow-watcher。`);
    }
    projectNode.set('ref', newRef);
    document.setIn(
      ['projects', projectIndex, 'jobs', watcherIndexes[0], 'config', 'branch_space'],
      newBranchSpace,
    );
  } else {
    throw new Error(`无法读取项目配置：${projectId}`);
  }

  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, document.toString(), { encoding: 'utf8', mode });
  await fs.rename(temporary, file);

  return { success: true, newRef, branchSpace: newBranchSpace };
}

/**
 * Format branch status or drift warning text
 */
export function formatProjectBranchStatus(info: ProjectBranchInfo & { projectName: string }): string {
  const lines = [
    `📌 **${info.projectName} (${info.projectId})** 仓库分支信息`,
    `📂 仓库路径：\`${info.projectPath}\``,
    `🌿 仓库实际 Git 分支：\`${info.actualBranch}\`${info.isDetached ? ' (Detached HEAD)' : ''}`,
    `🎯 系统监控分支：\`${info.monitoredBranch}\` (\`${info.monitoredRef}\`)`,
    `🔗 当前 HEAD Commit：\`${info.headCommit.slice(0, 10)}\``,
  ];

  if (info.isDrifted) {
    lines.push(
      '',
      `⚠️ **监控分支漂移警告**：`,
      `仓库当前实际分支 (\`${info.actualBranch}\`) 与系统监控分支 (\`${info.monitoredBranch}\`) 不一致！`,
      `推送至实际分支的提交与 PLAN 自动化将**不会**自动被 Workflow Watcher 触发。`,
      '',
      `💡 **后续操作**：`,
      `- 用户提交分支更换申请：\`/ap branch apply\` 或 \`/ap branch apply ${info.actualBranch}\``,
      `- 管理员直接更换监控分支：\`/ap branch switch ${info.actualBranch}\``,
    );
  } else {
    lines.push('✅ 监控分支状态正常，未发生漂移。');
  }

  return lines.join('\n');
}

/**
 * Submit branch switch approval (non-admin flow)
 */
export async function createBranchSwitchApproval(args: {
  project: ProjectConfig;
  targetBranch: string;
  branchSpace?: string;
  requesterOpenId: string;
  requesterChatId: string;
}): Promise<{ approvalId: string; message: string }> {
  const target = await inspectProjectBranchTarget(args.project, args.targetBranch, args.branchSpace);
  const { targetRef, targetBranch, branchSpace, watchRoot } = target;
  const currentBranch = args.project.ref.replace(/^refs\/heads\//, '');
  const currentBranchSpace = String(workflowJob(args.project).config.branch_space || '');

  if (targetBranch === currentBranch && branchSpace === currentBranchSpace) {
    return {
      approvalId: '',
      message: `项目 ${args.project.name} 已监控 \`${targetBranch}\` / \`${branchSpace}\`，无需申请更换。`,
    };
  }
  await assertProjectBranchSwitchReady(args.project);

  const payload = {
    projectId: args.project.id,
    projectName: args.project.name,
    currentRef: args.project.ref,
    currentBranch,
    currentBranchSpace,
    targetRef,
    targetBranch,
    branchSpace,
    watchRoot,
    requesterOpenId: args.requesterOpenId,
    requesterChatId: args.requesterChatId,
  };

  const approval = await prisma.feishuAdminApproval.create({
    data: {
      kind: 'branch_switch',
      status: 'pending',
      requesterOpenId: args.requesterOpenId,
      requesterChatId: args.requesterChatId,
      payloadJson: JSON.stringify(payload),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  const approverOpenIds = args.project.feishu.approver_open_ids;
  const approverListStr = approverOpenIds.length
    ? approverOpenIds.map((id) => `<at user_id="${id}"></at>`).join(' ')
    : '管理员';

  const cardContent = {
    config: { wide_screen_mode: true },
    header: {
      template: 'amber',
      title: { tag: 'plain_text', content: `🌿 监控分支更换申请 [${args.project.name}]` },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**项目**：${args.project.name} (\`${args.project.id}\`)`,
          `**申请人**：<at user_id="${args.requesterOpenId}"></at>`,
          `**原监控分支**：\`${currentBranch}\``,
          `**申请切换为**：\`${targetBranch}\` (\`${targetRef}\`)`,
          `**Branch space**：\`${branchSpace}\``,
          `**完整监控目录**：\`${watchRoot}\`（已在目标分支提交）`,
          `**审批对象**：${approverListStr}`,
          `**申请单 ID**：\`${approval.id}\``,
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 同意更换监控分支' },
            type: 'primary',
            value: `admin-approval:approve:${approval.id}`,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝申请' },
            type: 'danger',
            value: `admin-approval:deny:${approval.id}`,
          },
        ],
      },
    ],
  };

  await sendFeishuInteractiveMessage({
    receiveId: args.requesterChatId,
    receiveIdType: 'chat_id',
    card: cardContent,
  }).catch((err) => {
    console.error('Failed to send branch switch approval card:', err);
  });

  return {
    approvalId: approval.id,
    message: [
      `✅ 已提交监控分支变更申请。`,
      `项目：${args.project.name}`,
      `原监控分支：\`${currentBranch}\``,
      `目标监控分支：\`${targetBranch}\``,
      `Branch space：\`${branchSpace}\``,
      `完整监控目录：\`${watchRoot}\``,
      `申请单 ID：\`${approval.id}\``,
      `已通知项目审批人 / 管理员进行审批。`,
    ].join('\n'),
  };
}

/**
 * Handle admin approval or resolution of branch switch request
 */
export async function resolveBranchSwitchApproval(args: {
  approvalId: string;
  approved: boolean;
  actorOpenId: string;
}): Promise<string> {
  const approval = await prisma.feishuAdminApproval.findUnique({
    where: { id: args.approvalId },
  });

  if (!approval || approval.kind !== 'branch_switch') {
    throw new Error(`未找到分支更换申请：${args.approvalId}`);
  }

  if (approval.status !== 'pending') {
    return `申请单 ${args.approvalId} 当前状态为 \`${approval.status}\`，无法重复处理。`;
  }

  const payload = JSON.parse(approval.payloadJson || '{}') as {
    projectId: string;
    projectName: string;
    currentBranch: string;
    currentRef: string;
    currentBranchSpace: string;
    targetBranch: string;
    targetRef: string;
    branchSpace: string;
    watchRoot: string;
  };

  const project = findProjectById(await loadProjectsConfig(), payload.projectId);
  if (!project) {
    throw new Error(`项目 ${payload.projectId} 不存在。`);
  }

  const isAdmin = isFeishuAdmin(args.actorOpenId);
  const isApprover = project.feishu.approver_open_ids.includes(args.actorOpenId);
  if (!isAdmin && !isApprover) {
    throw new Error('只有平台管理员或项目审批人可以处理此分支变更申请。');
  }

  const now = new Date();
  if (args.approved) {
    if (!payload.branchSpace || !payload.currentRef) {
      throw new Error('旧版申请缺少 branch_space，请拒绝后重新申请。');
    }
    const currentBranchSpace = String(workflowJob(project).config.branch_space || '');
    if (project.ref !== payload.currentRef || currentBranchSpace !== payload.currentBranchSpace) {
      throw new Error('项目监控配置已变化，请重新提交分支切换申请。');
    }
    await assertProjectBranchSwitchReady(project);
    const target = await inspectProjectBranchTarget(project, payload.targetRef, payload.branchSpace);
    await updateProjectMonitoredBranch(payload.projectId, target.targetRef, target.branchSpace);
    await prisma.feishuAdminApproval.update({
      where: { id: args.approvalId },
      data: {
        status: 'approved',
        resolvedBy: args.actorOpenId,
        resolvedAt: now,
      },
    });

    return [
      `✅ 分支变更申请已批准！`,
      `项目：${payload.projectName} (\`${payload.projectId}\`)`,
      `监控分支已由 \`${payload.currentBranch}\` 更新为 \`${payload.targetBranch}\` (\`${payload.targetRef}\`)。`,
      `Branch space 已更新为 \`${target.branchSpace}\`，完整监控目录：\`${target.watchRoot}\`。`,
      `Workflow Watcher 即刻起监听新分支。`,
    ].join('\n');
  } else {
    await prisma.feishuAdminApproval.update({
      where: { id: args.approvalId },
      data: {
        status: 'denied',
        resolvedBy: args.actorOpenId,
        resolvedAt: now,
      },
    });

    return [
      `❌ 分支变更申请已被拒绝。`,
      `项目：${payload.projectName}`,
      `目标分支 \`${payload.targetBranch}\` 未被生效。`,
    ].join('\n');
  }
}
