import assert from 'node:assert/strict';
import '../src/lib/scheduled-jobs/workflow-watcher';
import { jobHandlers } from '../src/lib/scheduled-jobs/handlers';
import type { JobConfig } from '../src/lib/scheduled-jobs/project-config';

async function main() {
  assert.equal(typeof jobHandlers.get('workflow_watcher'), 'function');

  const policy = await import('../src/lib/feishu-workflow-policy');
  const plan = await import('../src/lib/feishu-plan');
  const graph = await import('../src/lib/feishu-task-graph-command');
  Object.assign(policy, { handleWorkflowPolicyCommand: async () => 'handover status' });
  Object.assign(plan, { handleFeishuPlanCommand: async () => 'plan discussion' });
  Object.assign(graph, { handleFeishuTaskGraphCommand: async () => 'graph status' });
  const { handleFeishuCommand } = await import('../src/lib/feishu');
  for (const [command, expected] of [['workflow', 'handover status'], ['plan', 'plan discussion'], ['graph', 'graph status']] as const) {
    assert.equal(await handleFeishuCommand({
      command: { command, args: ['status'], options: {} }, baseUrl: 'http://localhost',
    }), expected);
  }

  const review = await import('../src/lib/scheduled-jobs/workflow-review');
  const api = await import('../src/lib/feishu-api');
  const jobs = await import('../src/lib/feishu-scheduled-jobs');
  let reviews = 0, feedbacks = 0, resolved = 0, dashboards = 0;
  Object.assign(review, {
    resolveWorkflowReviewCardAction: async (args: Record<string, unknown>) => {
      reviews++;
      assert.equal(args.pendingKey, 'event');
      assert.equal(args.messageId, 'card');
      assert.equal(args.reviewAttempt, 3);
      return { status: args.actorOpenId === 'approver' ? 'applied' : 'forbidden', chatId: 'chat' };
    },
    resolveWorkflowRevisionFeedbackCardAction: async (args: Record<string, unknown>) => {
      feedbacks++;
      assert.equal(args.feedback, 'fix scope');
      assert.equal(args.actorOpenId, 'approver');
      return { status: 'applied', chatId: 'chat' };
    },
  });
  Object.assign(api, {
    updateFeishuApprovalCardResolved: async () => { resolved++; },
    sendFeishuTextMessage: async () => 'receipt',
  });
  Object.assign(jobs, { handleWorkflowDashboardCardAction: async (args: Record<string, unknown>) => {
    dashboards++;
    assert.equal(args.actorOpenId, 'approver');
    assert.equal(args.selectedPlan, 'docs/001_PLAN.md');
    return 'selected';
  } });
  const { buildCardActionHandler } = await import('../src/lib/feishu-long-connection');
  const callback = buildCardActionHandler('[test]');
  const invoke = (cmd: string, actor = 'approver', form_value: Record<string, unknown> = {}) => callback({
    open_id: actor, tenant_key: 'tenant', open_message_id: 'card', token: 'token',
    operator: { open_id: actor },
    context: { open_chat_id: 'chat', open_message_id: 'card' },
    action: { tag: 'button', value: { cmd, projectId: 'project', jobId: 'workflow-watcher',
      pendingKey: 'event', reviewAttempt: 3, decision: 'approve', action: 'activate_plan' }, form_value },
  } as Parameters<typeof callback>[0]);
  assert.match(JSON.stringify(await invoke('workflow-review', 'intruder')), /forbidden/);
  assert.equal(resolved, 0, 'Rejected approvals must not resolve the card');
  assert.match(JSON.stringify(await invoke('workflow-review')), /审批已记录/);
  assert.equal(reviews, 2);
  assert.equal(resolved, 1);
  assert.match(JSON.stringify(await invoke('workflow-revision-feedback')), /请填写/);
  assert.equal(feedbacks, 0);
  await invoke('workflow-revision-feedback', 'approver', { reviewFeedback: ' fix scope ' });
  assert.equal(feedbacks, 1);
  await invoke('workflow-dashboard', 'approver', { selectedPlan: 'docs/001_PLAN.md' });
  assert.equal(dashboards, 1);

  const workflow = await import('../src/lib/live-room-workflows');
  const prismaModule = await import('../src/lib/prisma');
  let content = '/plan restore handover', plans = 0, workflows = 0;
  Object.assign(workflow, {
    runLiveRoomPlan: async (args: { content: string }) => {
      if (!args.content.startsWith('/plan ')) return false;
      plans++;
      return true;
    },
    runLiveRoomWorkflow: async (args: { level: string }) => {
      assert.equal(args.level, 'implement');
      workflows++;
    },
  });
  Object.assign(prismaModule, { prisma: {
    liveRoom: { findUnique: async () => ({ id: 'room', mode: 'execution', members: [] }) },
    liveRoomMessage: { findUnique: async () => ({ id: 'message', content, metadata: null }) },
  } });
  const { triggerLiveRoomMessageReplies } = await import('../src/lib/live-room-delivery');
  const deliver = () => triggerLiveRoomMessageReplies({ roomId: 'room', roomMessageId: 'message' });
  await deliver();
  content = '/run feature --level=implement restore handover';
  await deliver();
  content = '普通聊天';
  await deliver();
  assert.equal(plans, 1);
  assert.equal(workflows, 1, 'Ordinary chat must not enter document workflow orchestration');

  const config = await import('../src/lib/scheduled-jobs/project-config');
  const { wakeWorkflowWatcherForTaskRun } = await import('../src/lib/scheduled-jobs/runner');
  let enabledOverride: boolean | null = false, dispatched = 0;
  const job: JobConfig = { id: 'workflow-watcher', type: 'workflow_watcher', enabled: false,
    mode: 'active', schedule: '* * * * *', config: { coding_bot_chat_id: 'chat' } };
  Object.assign(config, { loadProjectsConfig: async () => ({ projects: [{
    id: 'project', feishu: { chat_id: 'chat' }, jobs: [job],
  }] }) });
  const fakeDb = {
    feishuConversationBinding: { findFirst: async () => ({ chatId: 'chat' }) },
    scheduledJobState: { findUnique: async () => ({ enabledOverride }) },
    scheduledJobRun: { create: async () => { dispatched++; throw new Error('dispatch reached'); } },
  };
  const wake = () => wakeWorkflowWatcherForTaskRun(fakeDb as unknown as Parameters<typeof wakeWorkflowWatcherForTaskRun>[0], 'task', 'run');
  assert.equal(await wake(), false);
  enabledOverride = null;
  assert.equal(await wake(), false);
  assert.equal(dispatched, 0, 'Disabled completion events must not touch the dispatch ledger');
  job.enabled = true;
  await assert.rejects(wake(), /dispatch reached/);
  assert.equal(dispatched, 1, 'Enabled completion events must reach the registered scheduler');
  const targeted = (projectId: string, jobId: string) => wakeWorkflowWatcherForTaskRun(fakeDb as unknown as Parameters<typeof wakeWorkflowWatcherForTaskRun>[0], 'task', 'run', { projectId, jobId });
  assert.equal(await targeted('other-project', 'workflow-watcher'), false);
  assert.equal(await targeted('project', 'other-job'), false);
  await assert.rejects(targeted('project', 'workflow-watcher'), /dispatch reached/);
  assert.equal(dispatched, 2, 'A registered completion must target its exact project and job');
  console.log('HANDOVER command, card callbacks, handler registration and wakeup gates passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
