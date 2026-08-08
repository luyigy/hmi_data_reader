import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { prisma } from '@/lib/prisma';
import {
  findProjectByChatId,
  findProjectById,
  loadProjectsConfig,
} from '@/lib/scheduled-jobs/project-config';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import {
  assertProjectBranchSwitchReady,
  createBranchSwitchApproval,
  formatProjectBranchStatus,
  inspectProjectBranch,
  inspectProjectBranchTarget,
  resolveBranchSwitchApproval,
  updateProjectMonitoredBranch,
} from '@/lib/scheduled-jobs/project-branch';

export async function handleBranchCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
): Promise<string> {
  const config = await loadProjectsConfig();
  const subCommand = command.args[0]?.toLowerCase() || 'status';

  const targetProjectId = command.options['project'];

  let project = targetProjectId
    ? findProjectById(config, targetProjectId)
    : context
      ? findProjectByChatId(config, context.chatId)
      : undefined;

  if (!project && config.projects.length === 1) {
    project = config.projects[0];
  }

  if (subCommand === 'approvals' || subCommand === 'list') {
    const pendingList = await prisma.feishuAdminApproval.findMany({
      where: { kind: 'branch_switch', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (!pendingList.length) {
      return '📋 当前没有待处理的分支变更申请。';
    }

    const items = pendingList.map((app) => {
      const payload = JSON.parse(app.payloadJson || '{}');
      return [
        `• 单号：\`${app.id}\``,
        `  项目：${payload.projectName || payload.projectId}`,
        `  原分支：\`${payload.currentBranch || '-'}\``,
        `  申请分支：\`${payload.targetBranch || '-'}\``,
        `  Branch space：\`${payload.branchSpace || '-'}\``,
        `  申请人：<at user_id="${app.requesterOpenId}"></at>`,
        `  时间：${app.createdAt.toISOString().slice(0, 19).replace('T', ' ')}`,
      ].join('\n');
    });

    return [
      `📋 **待处理的监控分支变更申请** (${pendingList.length}条)：`,
      '',
      ...items,
      '',
      '💡 管理员可以通过以下命令处理：',
      '`/ap approve <ID>` 或 `/ap deny <ID>`',
    ].join('\n');
  }

  if (subCommand === 'approve' || subCommand === 'deny') {
    const approvalId = command.args[1];
    if (!approvalId) {
      return `用法：/ap branch ${subCommand} <approval_id>`;
    }
    if (!context) {
      return '当前命令需要 Feishu 会话上下文。';
    }
    return resolveBranchSwitchApproval({
      approvalId,
      approved: subCommand === 'approve',
      actorOpenId: context.senderOpenId,
    });
  }

  if (!project) {
    return [
      '❌ 未找到对应的 Workflow 项目。',
      '请在绑定的项目群中发送命令，或使用 `--project=<project_id>` 参数。',
      `可选项目列表：${config.projects.map((p) => `\`${p.id}\``).join(', ')}`,
    ].join('\n');
  }

  if (subCommand === 'status' || subCommand === 'show') {
    const branchInfo = await inspectProjectBranch(project.path, project.ref);
    return formatProjectBranchStatus({
      ...branchInfo,
      projectId: project.id,
      projectName: project.name,
    });
  }

  if (subCommand === 'apply') {
    if (!context) {
      return '提交分支申请需要来自 Feishu 会话上下文。';
    }

    let targetBranch = command.args[1];
    if (!targetBranch) {
      const branchInfo = await inspectProjectBranch(project.path, project.ref);
      if (branchInfo.isDetached || branchInfo.actualBranch === 'unknown') {
        return '❌ 无法检测仓库当前 Git 分支 (Detached HEAD 或未知)，请显式指定分支名：`/ap branch apply <branch_name>`';
      }
      targetBranch = branchInfo.actualBranch;
    }

    const result = await createBranchSwitchApproval({
      project,
      targetBranch,
      branchSpace: command.options['branch-space'],
      requesterOpenId: context.senderOpenId,
      requesterChatId: context.chatId,
    });

    return result.message;
  }

  if (subCommand === 'switch' || subCommand === 'set') {
    if (!context) {
      return '切换监控分支需要 Feishu 会话上下文。';
    }

    const isAdmin = isFeishuAdmin(context.senderOpenId);
    const isApprover = project.feishu.approver_open_ids.includes(context.senderOpenId);
    if (!isAdmin && !isApprover) {
      return [
        '🔒 权限不足：直接切换监控分支需要平台管理员或项目审批人权限。',
        '普通用户请使用 `/ap branch apply [new_branch]` 提交更换申请。',
      ].join('\n');
    }

    let targetBranch = command.args[1];
    if (!targetBranch) {
      const branchInfo = await inspectProjectBranch(project.path, project.ref);
      if (!branchInfo.isDrifted || branchInfo.isDetached) {
        return '用法：`/ap branch switch <new_branch_name>`';
      }
      targetBranch = branchInfo.actualBranch;
    }

    const target = await inspectProjectBranchTarget(
      project,
      targetBranch,
      command.options['branch-space'],
    );
    await assertProjectBranchSwitchReady(project);
    const { newRef, branchSpace } = await updateProjectMonitoredBranch(
      project.id,
      target.targetRef,
      target.branchSpace,
    );
    return [
      `✅ 已将项目 **${project.name}** 的监控分支切换为：\`${targetBranch}\` (\`${newRef}\`)。`,
      `Branch space：\`${branchSpace}\`，完整监控目录：\`${target.watchRoot}\`。`,
      `Workflow Watcher 即刻起开始监控新分支。`,
    ].join('\n');
  }

  return [
    '💡 **Gitee / Git 监控分支管理命令用法**：',
    '• `/ap branch` 或 `/ap branch status` — 查询当前仓库实际分支、监控分支与漂移状态',
    '• `/ap branch apply [new_branch] [--branch-space=name]` — 提交分支与 branch_space 确认申请',
    '• `/ap branch switch <new_branch> [--branch-space=name]` — （管理员）直接切换并同步 branch_space',
    '• `/ap branch approvals` — 查看所有待审批的分支切换申请单',
  ].join('\n');
}
