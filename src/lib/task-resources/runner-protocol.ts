import { prisma } from '../prisma';
import { requestResourceAccess, getResourceApproval } from './access';
import { resourceTaskBinding } from './delivery';
import { publishResourceApproval } from './cards';
import type { AcpxParticipantRequest, AcpxRunRequest } from '../acpx/types';
import type { ResourceInput } from './model';

export const resourceRequestInstructions = `
需要当前任务尚未授权的额外目录时，最终答复只能包含下面这一份结构化申请，不加说明文字或 Markdown 代码围栏：
<resource-request>{"purpose":"说明用途","resources":[{"path":"/absolute/directory","access":"read"}]}</resource-request>
access 可为 read 或 write；一次列出已知缺项。平台生成补充授权卡，批准后挂载并继续原会话。
申请只包含用途和目录，不填写用户、任务或会话身份。输出申请后结束当前轮次，等待平台处理。
当前已有权限内的依赖安装和测试直接执行，不重复申请。工具不存在或安装失败须报告实际错误。
`;

export function resourceInstructions(permission: AcpxRunRequest['permissionConfig']): string {
  if (permission?.profile === 'full_access') return `
本次运行已获 Full Access，仓库外目录访问已在当前权限范围内。不要仅因目录位于仓库外而提交资源申请或等待补充审批。
在用户授权的任务范围内直接完成必要读取与验证；任务明确的只读输入、受控资源和禁止修改范围仍须遵守。
如果先前资源申请已被平台判定为“已在当前授权范围内”，无需等待审批卡，也不要把它当作阻塞。
工具不存在或操作实际失败时报告真实错误，不把依赖缺失误报为目录待授权。
`;
  return resourceRequestInstructions;
}

export function parseResourceRequest(output: string): { purpose: string; resources: ResourceInput[] } | null {
  const source = output.trim();
  // Only a whole-message envelope is a command. Prose, quotes and code examples are conversation.
  if (!source.startsWith('<resource-request>') || !source.slice('<resource-request>'.length).trimStart().startsWith('{')) return null;
  const matches = Array.from(source.matchAll(/<resource-request>([\s\S]*?)<\/resource-request>/g));
  if (!matches.length) {
    throw new Error('资源申请缺少结束标记');
  }
  if (!source.endsWith('</resource-request>')) return null;
  if (matches.length !== 1) throw new Error('每轮只能提交一份完整的资源申请');
  if (matches[0][0] !== source) return null;
  const value: unknown = JSON.parse(matches[0][1]);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['purpose', 'resources'].includes(key)) ||
      !('purpose' in value) || typeof value.purpose !== 'string' || !value.purpose.trim() || value.purpose.length > 2000 ||
      !('resources' in value) || !Array.isArray(value.resources) || !value.resources.length || value.resources.length > 20) {
    throw new Error('资源申请须包含用途和 1 至 20 个目录');
  }
  const resources = value.resources.map((entry: unknown): ResourceInput => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['path', 'access'].includes(key)) ||
        !('path' in entry) || typeof entry.path !== 'string' || !entry.path.startsWith('/') ||
        !('access' in entry) || !['read', 'write'].includes(String(entry.access))) throw new Error('资源目录必须是绝对路径，权限必须是 read 或 write');
    return { path: entry.path, access: entry.access === 'write' ? 'write' : 'read' };
  });
  return { purpose: value.purpose.trim(), resources };
}

export async function submitRunnerResourceRequest(args: {
  request: AcpxRunRequest; taskRunId: string; participantId: string; participant: AcpxParticipantRequest; output: string; protocolOutput?: string | null;
  onResolved?: (message: string) => void | Promise<void>;
}): Promise<string> {
  const proposal = parseResourceRequest(args.protocolOutput === undefined ? args.output : args.protocolOutput || '');
  const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.taskRunId }, include: { task: true } });
  const existingId: unknown = JSON.parse(run.controlMetadata || '{}').resourceRequestId;
  if (!proposal && typeof existingId !== 'string') return args.output;
  let approval = typeof existingId === 'string' ? await getResourceApproval(existingId) : undefined;
  if (!approval && proposal) {
    const binding = await resourceTaskBinding(run.taskId);
    const launch = { ...args.request };
    delete launch.streamCallbacks;
    delete launch.resourceContinuation;
    const result = await requestResourceAccess({
      launch: { ...launch, taskSessionId: run.taskSessionId || undefined, participants: [args.participant] },
      source: { taskRunId: args.taskRunId, participantId: args.participantId }, ...proposal,
      requesterOpenId: binding?.senderOpenId || `platform:${run.task.ownerUserId || run.taskId}`,
      requesterChatId: binding?.chatId || '',
    });
    if (result.kind === 'covered') {
      const note = '所申请目录已在当前授权范围内，无须重复申请或等待审批卡。';
      await args.onResolved?.(note);
      return args.output.replace(/<resource-request>[\s\S]*?<\/resource-request>/g, note);
    }
    approval = result.approval;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${run.id} FOR UPDATE`;
      const current = await tx.taskRun.findUniqueOrThrow({ where: { id: run.id } });
      await tx.taskRun.update({ where: { id: run.id }, data: { controlMetadata: JSON.stringify({ ...JSON.parse(current.controlMetadata || '{}'), resourceRequestId: approval!.id }) } });
    });
    await publishResourceApproval(approval.id).catch(error => console.warn('[Resources] approval card delivery failed', error instanceof Error ? error.message : String(error)));
  }
  if (!approval) return args.output;
  const note = approval.status === 'denied' ? `资源申请 ${approval.id} 已被拒绝，保留当前工作。`
    : `资源申请 ${approval.id} 已提交。批准后平台挂载目录并继续本会话。`;
  await args.onResolved?.(note);
  if (args.request.graphExecution) return `TASK_GRAPH_IMPLEMENTATION ${JSON.stringify({ status: 'blocked', blockerKind: 'permission_required', note })}`;
  if (args.request.graphReview) return `${args.request.graphReview.phase === 'architecture' ? 'TASK_GRAPH_ARCH_REVIEW' : 'TASK_GRAPH_REVIEW'} ${JSON.stringify({ approved: false, failureKind: 'blocked_require_human', note })}`;
  return note;
}
