import type { TaskGraphNode, TaskGraphExecution } from '@prisma/client';
import { executionProgress } from './execution-progress';
import { graphCardStatus } from './card-status';
import { formatGraphFailureSummary } from './failure-summary';
import { redactSensitiveText } from '../redact-sensitive';

type Node = Pick<TaskGraphNode, 'key' | 'status' | 'evidence'> & {
  executions: Pick<TaskGraphExecution, 'key' | 'dispatchMetadata'>[];
};

export function buildGraphNodeCard(node: Node) {
  const progresses = node.executions.map(job => executionProgress(job.dispatchMetadata));
  const appearance = graphCardStatus(node.status, progresses);
  const evidence = node.evidence;
  const reviewNote = node.status === 'attention' && evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    && typeof evidence.summary === 'string' ? evidence.summary : '';
  const details = reviewNote || node.executions.map((job, index) => {
    const p = progresses[index];
    const note = node.status === 'attention' ? p?.waitingMessage || (p?.lastFailure ? formatGraphFailureSummary(p.lastFailure, p.state) : '') : '';
    return note ? `${job.key}：${note}` : '';
  }).filter(Boolean).join('\n');
  return { schema: '2.0', config: { update_multi: true },
    header: { template: appearance.template, title: { tag: 'plain_text', content: `${appearance.icon} ${node.key} · ${appearance.label}` } },
    body: { elements: [
      { tag: 'markdown', content: `**${appearance.label}**${details ? `\n${redactSensitiveText(details).slice(0, 900)}` : ''}` },
      { tag: 'markdown', content: '原 Agent 的回复、测试证据与操作记录见本话题。' },
    ] } };
}
