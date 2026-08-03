import type { WorkflowStatus } from './workflow-status';

export function buildWorkflowDocumentForms(args: {
  status: WorkflowStatus;
  pending: Record<string, unknown> | null;
}) {
  const overview = args.status.overview;
  if (!overview) return [];
  const groups = [
    { label: 'Inbox', field: 'selectedInboxDocument', documents: overview.inbox },
    { label: 'PLAN', field: 'selectedPlanDocument', documents: overview.plans },
    { label: 'HANDOVER', field: 'selectedHandoverDocument', documents: overview.handovers },
  ];
  const cancellablePlans = overview.plans.filter(({ path }) => !args.pending?.path || args.pending.path === path);
  return [
    ...(cancellablePlans.length && !args.status.running ? [{
      tag: 'form',
      name: 'workflow-plan-cancellation',
      elements: [{
        tag: 'select_static', name: 'selectedCancelledPlan', required: true, width: 'fill',
        placeholder: { tag: 'plain_text', content: '选择不再实施的 PLAN' },
        options: cancellablePlans.map((plan) => ({
          text: { tag: 'plain_text', content: `${plan.number} ${plan.title}` }, value: plan.path,
        })),
      }, {
        tag: 'button', name: 'cancelWorkflowPlan', type: 'danger', width: 'fill', action_type: 'form_submit',
        text: { tag: 'plain_text', content: '取消实施所选 PLAN' },
        confirm: {
          title: { tag: 'plain_text', content: '确认取消实施' },
          text: { tag: 'plain_text', content: '这会把 PLAN 标记为 superseded / none，并停止剩余 Slice。' },
        },
        value: {
          cmd: 'workflow-dashboard', action: 'plan_cancel', projectId: args.status.projectId,
          jobId: args.status.jobId, expectedHead: args.status.head,
        },
      }],
    }] : []),
    ...groups.filter(({ documents }) => documents.length).map((group) => ({
      tag: 'form',
      name: `workflow-document-export-${group.label.toLowerCase()}`,
      elements: [{
        tag: 'select_static', name: group.field, required: true, width: 'fill',
        placeholder: { tag: 'plain_text', content: `选择 ${group.label}` },
        options: group.documents.map((document) => ({
          text: { tag: 'plain_text', content: `${group.label} · ${document.title}` }, value: document.path,
        })),
      }, {
        tag: 'button', name: `exportWorkflowDocument${group.label}`, type: 'primary_filled',
        width: 'fill', action_type: 'form_submit',
        text: { tag: 'plain_text', content: `查看 ${group.label} 飞书文档` },
        value: {
          cmd: 'workflow-dashboard', action: 'document', projectId: args.status.projectId,
          jobId: args.status.jobId, expectedHead: args.status.head,
        },
      }],
    })),
  ];
}
