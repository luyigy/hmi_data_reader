import { graphValidationArchiveForTask } from './validation-archive-access';
import { syncGraphConversationMaterials } from './conversation-materials';
import { existsSync } from 'node:fs';
import { prisma } from '../prisma';
import type { syncLiveRoomSourceTask } from '../live-room-members';
import { redactSensitiveText } from '../redact-sensitive';
import { taskGraphAgentReviewPermissionConfig } from './review-permissions';

type SourceTask = NonNullable<Awaited<ReturnType<typeof syncLiveRoomSourceTask>>>;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Questions never continue an implementation session or mutate its execution state. */
export async function prepareGraphConversationTask(source: SourceTask): Promise<SourceTask> {
  const execution = await prisma.taskGraphExecution.findFirst({ where: { childTaskId: source.id }, include: { node: { include: { run: true } } } });
  if (!execution) {
    const parent = await prisma.taskGraphRun.findFirst({ where: { parentTaskId: source.id }, orderBy: { version: 'desc' } });
    return parent ? { ...source, description: `${source.description || ''}\n用户明确要求继续时可输出 <graph-control>{"action":"resume_acceptance","nodeKey":"实际节点键"}</graph-control>。只问状态或只发图不得恢复，不让用户搬图或补发 resume。` } : source;
  }
  const receipt = await prisma.taskGraphEvent.findFirst({ where: { runId: execution.node.runId, kind: 'workspace_cleaned',
    payload: { path: ['executionId'], equals: execution.id } }, orderBy: { createdAt: 'desc' } });
  const archived = record(receipt?.payload) && typeof receipt.payload.resultsDirectory === 'string' ? receipt.payload.resultsDirectory : null;
  const validationArchive = await graphValidationArchiveForTask(source.id);
  const directory = [execution.worktreePath, archived, validationArchive, execution.repository].find((value): value is string => !!value && existsSync(value));
  if (!directory) throw new Error('任务工作区和证据目录不可用；不能隐式重新实施，请检查保存结果。');
  const snapshot = execution.node.run.snapshot;
  const planned = record(snapshot) && Array.isArray(snapshot.nodes)
    ? snapshot.nodes.find((node) => record(node) && node.key === execution.node.key) : null;
  const goal = record(planned) && typeof planned.goal === 'string' ? planned.goal : source.name;
  const history = await prisma.taskRun.findMany({ where: { taskId: { in: [source.id,
    `task-graph-review-${execution.nodeId}`, `task-graph-architecture-${execution.nodeId}`] } },
    orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, status: true, summary: true,
      participants: { select: { harnessType: true, summary: true, error: true } } } });
  const supplements = await prisma.liveRoomMessage.findMany({ where: { room: { sourceTaskId: { in: [source.id, execution.node.run.parentTaskId] } }, messageType: 'user' },
    orderBy: { createdAt: 'desc' }, take: 20, select: { content: true, createdAt: true } });
  const materials = await syncGraphConversationMaterials(source.id);
  const description = redactSensitiveText([
    '你在回答原任务话题的问题。这个会话仅用于只读问答、澄清材料与说明进度。',
    '不得重复实施、改代码、提交、合并、关闭 Issue，或仅凭用户提问宣布验收通过。',
    '执行中的写操作由原任务负责。需要补充资料时根据 Spec 明确机台品牌、页面、原图和答案来源；缺少规定时明确指出待裁定项，不猜测。',
    '用户在父话题或子话题补材料都可使用。明确要求继续验收时，输出 <graph-control>{"action":"resume_acceptance","nodeKey":"<当前 Slice 键>"}</graph-control>，由平台核验原用户权限并登记恢复；不要让用户搬图或补发 resume。仅发图、只读提问、否定继续时不得输出控制块。问答结论不代表验收通过。',
    `父任务：${execution.node.run.parentTaskId}；Slice：${execution.node.key}；当前状态：${execution.node.status}`,
    `目标：${goal}；固定提交：${execution.commit || '尚未集成'}`,
    `Spec：${record(execution.node.run.snapshot) ? String(execution.node.run.snapshot.specRef) : ''}`,
    `当前只读目录：${directory}。${directory === execution.repository ? '这是源仓，只能用固定提交读取交付版本，不要把源仓 HEAD 当交付结果。' : '可查阅 scratch 或 files 下保存的原始报告、截图和 JSON。'}`,
    ...(validationArchive ? [`验收报告已归档：${validationArchive}/files。manifest.json 保存原临时目录与相对路径，请按它定位旧报告，不再使用已清理的旧路径。`] : []),
    `已保存检查：${JSON.stringify(execution.evidence).slice(-12000)}`,
    `原话题材料与澄清：${JSON.stringify(supplements.reverse()).slice(-10000)}`,
    materials,
    `最近执行与验收历史：${JSON.stringify(history).slice(-10000)}`,
  ].join('\n'));
  return prisma.task.upsert({ where: { id: `task-graph-discussion-${execution.id}` }, create: {
    id: `task-graph-discussion-${execution.id}`, name: `${execution.node.key} · 任务问答`, description,
    executionMode: 'acpx', workingDirectory: directory, ownerUserId: source.ownerUserId,
    acpxPermissionConfig: JSON.stringify(taskGraphAgentReviewPermissionConfig),
  }, update: { description, workingDirectory: directory, acpxPermissionConfig: JSON.stringify(taskGraphAgentReviewPermissionConfig) },
    include: { currentTaskSession: true } });
}
