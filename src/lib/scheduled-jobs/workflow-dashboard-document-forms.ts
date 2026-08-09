import path from 'node:path';
import type { WorkflowStatus } from './workflow-status';

const documentNumber = (filePath: string) =>
  path.posix.basename(filePath).match(/^(\d+)_/)?.[1]?.padStart(3, '0') ?? '无编号';

export function buildWorkflowDocumentPanels(args: {
  status: WorkflowStatus;
  pending: Record<string, unknown> | null;
}) {
  const overview = args.status.overview;
  if (!overview) return [];
  const groups = [
    ...overview.inbox.map((document) => ({ ...document, type: 'Inbox' })),
    ...(overview.planDocuments ?? overview.plans).map((document) => ({ ...document, type: 'PLAN' })),
    ...overview.handovers.map((document) => ({ ...document, type: 'HANDOVER' })),
    ...(overview.others ?? []),
  ];
  const workflowDocuments = groups.filter(({ type }) => ['PLAN', 'HANDOVER'].includes(type));
  const button = (label: string, action: string, path: string, type = 'default') => ({
    tag: 'button', type,
    text: { tag: 'plain_text', content: label },
    ...(action.startsWith('plan_') ? {
      confirm: {
        title: { tag: 'plain_text', content: `确认${label}` },
        text: { tag: 'plain_text', content: action === 'plan_complete'
          ? '这会提交 PLAN 的 completed / await_acceptance 状态。'
          : '这会把 PLAN 标记为 superseded / none，并停止剩余 Slice。' },
      },
    } : {}),
    value: {
      cmd: 'workflow-dashboard', action, projectId: args.status.projectId,
      jobId: args.status.jobId, expectedHead: args.status.head,
      ...(action.startsWith('plan_') ? { selectedCompletionPlan: path } : { selectedDocument: path }),
    },
  });
  return [
    {
      tag: 'collapsible_panel', expanded: false,
      header: { title: { tag: 'plain_text', content: '✅ PLAN 人工完成 / 取消' } },
      elements: overview.plans.length
        ? overview.plans.flatMap((plan) => [{
          tag: 'markdown', content: `[编号 ${documentNumber(plan.path)}] PLAN · ${plan.title}`,
        }, {
          tag: 'action', actions: [
            button('人工标记完成', 'plan_complete', plan.path, 'danger'),
            button('取消实施', 'plan_cancel', plan.path, 'danger'),
          ],
        }])
        : [{ tag: 'markdown', content: '当前没有可人工完成或取消的未完成 PLAN。' }],
    },
    ...(groups.length ? [{
      tag: 'form', name: 'workflow-document-view',
      elements: [{
        tag: 'select_static', name: 'selectedDocument', required: true, width: 'fill',
        placeholder: { tag: 'plain_text', content: '选择要查看的文档' },
        options: groups.map((document) => ({
          text: { tag: 'plain_text', content: `[编号 ${documentNumber(document.path)}] ${document.type} · ${document.title}` },
          value: document.path,
        })),
      }, {
        tag: 'button', name: 'viewWorkflowDocument', type: 'primary_filled', width: 'fill', action_type: 'form_submit',
        text: { tag: 'plain_text', content: '查看所选文档' },
        value: { cmd: 'workflow-dashboard', action: 'document', projectId: args.status.projectId, jobId: args.status.jobId, expectedHead: args.status.head },
      }],
    }] : []),
    ...(workflowDocuments.length ? [{
      tag: 'form', name: 'workflow-document-validation',
      elements: [{
        tag: 'select_static', name: 'selectedWorkflowDocument', required: true, width: 'fill',
        placeholder: { tag: 'plain_text', content: '选择要校验的 PLAN 或 HANDOVER' },
        options: workflowDocuments.map((document) => ({
          text: { tag: 'plain_text', content: `[编号 ${documentNumber(document.path)}] ${document.type} · ${document.title}` },
          value: document.path,
        })),
      }, {
        tag: 'button', name: 'validateWorkflowDocument', type: 'primary_filled', width: 'fill', action_type: 'form_submit',
        text: { tag: 'plain_text', content: '校验所选 PLAN / HANDOVER' },
        value: { cmd: 'workflow-dashboard', action: 'document_validate', projectId: args.status.projectId, jobId: args.status.jobId, expectedHead: args.status.head },
      }],
    }] : []),
  ];
}
