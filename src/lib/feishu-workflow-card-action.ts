import { sendFeishuTextMessage, updateFeishuApprovalCardResolved } from './feishu-api';
import { handleWorkflowDashboardCardAction } from './feishu-scheduled-jobs';
import {
  resolveWorkflowReviewCardAction,
  resolveWorkflowRevisionFeedbackCardAction,
  type WorkflowReviewDecision,
} from './scheduled-jobs/workflow-review';

export async function handleWorkflowCardAction(args: {
  value: Record<string, unknown>;
  formValue?: Record<string, unknown>;
  openId?: string;
  chatId?: string;
  messageId?: string;
  prefix: string;
}) {
  const { value, formValue, openId, chatId, messageId, prefix } = args;
  const cmd = value.cmd;
  const actorName = openId ? `openid:${openId.slice(-6)}` : '用户';
  if (cmd === 'workflow-dashboard') {
    if (typeof value.projectId !== 'string'
      || typeof value.jobId !== 'string'
      || typeof value.action !== 'string') return {};
    void handleWorkflowDashboardCardAction({
      projectId: value.projectId,
      jobId: value.jobId,
      action: value.action,
      actorOpenId: openId,
      cardMessageId: messageId,
      expectedHead: typeof value.expectedHead === 'string' ? value.expectedHead : undefined,
      selectedPlan: typeof formValue?.selectedPlan === 'string' ? formValue.selectedPlan : undefined,
      selectedCompletionPlan: typeof value.selectedCompletionPlan === 'string' ? value.selectedCompletionPlan : typeof formValue?.selectedCompletionPlan === 'string' ? formValue.selectedCompletionPlan : typeof formValue?.selectedCancelledPlan === 'string' ? formValue.selectedCancelledPlan : undefined,
      selectedDocument: typeof value.selectedDocument === 'string' ? value.selectedDocument : ['selectedDocument', 'selectedInboxDocument', 'selectedPlanDocument', 'selectedHandoverDocument', 'selectedOtherDocument', 'selectedWorkflowDocument'].map((field) => formValue?.[field]).find((selected): selected is string => typeof selected === 'string'), selectedCursorRecovery: typeof formValue?.selectedCursorRecovery === 'string' ? formValue.selectedCursorRecovery : undefined,
    }).then((result) => {
      console.log(`${prefix} workflow dashboard action completed`, {
        action: value.action,
        projectId: value.projectId,
        jobId: value.jobId,
        result,
      });
    }).catch((err) => {
      console.error(`${prefix} workflow dashboard action failed`, { err });
      if (chatId) {
        void sendFeishuTextMessage({
          receiveId: chatId,
          receiveIdType: 'chat_id',
          replyId: messageId,
          text: '❌ Workflow Dashboard 操作失败，请稍后重试。',
        }).catch(() => undefined);
      }
    });
    return { toast: { type: 'success', content: '操作已接收；完成后会回复结果' } };
  }

  if (cmd === 'workflow-review') {
    const decision = value.decision;
    const reviewFeedback = typeof formValue?.reviewFeedback === 'string'
      ? formValue.reviewFeedback.trim()
      : '';
    const roleWorkflowLevel = typeof formValue?.roleWorkflowLevel === 'string'
      ? formValue.roleWorkflowLevel
      : undefined;
    if (!['approve', 'reject', 'revision'].includes(String(decision))
      || typeof value.projectId !== 'string'
      || typeof value.jobId !== 'string'
      || typeof value.pendingKey !== 'string') return {};
    try {
      const result = await resolveWorkflowReviewCardAction({
        projectId: value.projectId,
        jobId: value.jobId,
        pendingKey: value.pendingKey,
        decision: decision as WorkflowReviewDecision,
        actorOpenId: openId,
        messageId,
        reviewAttempt: typeof value.reviewAttempt === 'number' ? value.reviewAttempt : undefined,
        reviewFeedback,
        roleWorkflowLevel,
      });
      if (result.status === 'applied' && messageId) {
        await updateFeishuApprovalCardResolved({
          messageId,
          resolution: decision === 'approve'
            ? 'approved'
            : decision === 'revision'
              ? 'revision'
              : 'rejected',
          actorName,
        }).catch((error) => console.error(`${prefix} failed to persist workflow review card result`, error));
      }
      if (result.status === 'applied' && decision !== 'approve') {
        await sendFeishuTextMessage({
          receiveId: result.chatId,
          receiveIdType: 'chat_id',
          text: decision === 'revision'
            ? reviewFeedback
              ? '✏️ PLAN 修改请求已记录，正在通知 Coding Agent 按反馈修订计划。'
              : '✏️ PLAN 修改请求已记录，请回复随后发送的询问消息；收到意见后才会启动 Coding Agent。'
            : '❌ PLAN 已拒绝，workflow-watcher 已立即处理，不会启动新的 Session。',
        }).catch((error) => console.error(`${prefix} failed to send workflow review receipt`, error));
      }
      return {
        toast: {
          type: result.status === 'applied' ? 'success' : 'warning',
          content: result.status === 'applied' ? '审批已记录' : `审批未生效：${result.status}`,
        },
      };
    } catch (err) {
      console.error(`${prefix} workflow review resolution failed`, { err });
      return { toast: { type: 'error', content: '审批处理失败，请稍后重试' } };
    }
  }

  if (cmd === 'workflow-revision-feedback') {
    const feedback = typeof formValue?.reviewFeedback === 'string'
      ? formValue.reviewFeedback.trim()
      : '';
    if (typeof value.projectId !== 'string'
      || typeof value.jobId !== 'string'
      || typeof value.pendingKey !== 'string') return {};
    if (!feedback) return { toast: { type: 'warning', content: '请填写具体修改意见' } };
    try {
      const result = await resolveWorkflowRevisionFeedbackCardAction({
        projectId: value.projectId,
        jobId: value.jobId,
        pendingKey: value.pendingKey,
        actorOpenId: openId,
        feedback,
      });
      if (result.status === 'applied' && messageId) {
        await updateFeishuApprovalCardResolved({
          messageId,
          resolution: 'revision',
          actorName,
        }).catch((error) => console.error(`${prefix} failed to persist revision feedback card result`, error));
      }
      if (result.status === 'applied') {
        await sendFeishuTextMessage({
          receiveId: result.chatId,
          receiveIdType: 'chat_id',
          text: '✏️ 修改意见已提交，正在通知 Coding Agent 只修订 PLAN。',
        }).catch((error) => console.error(`${prefix} failed to send revision feedback receipt`, error));
      }
      return {
        toast: {
          type: result.status === 'applied' ? 'success' : 'warning',
          content: result.status === 'applied' ? '修改意见已提交' : `提交未生效：${result.status}`,
        },
      };
    } catch (err) {
      console.error(`${prefix} workflow revision feedback failed`, { err });
      return { toast: { type: 'error', content: '修改意见提交失败，请稍后重试' } };
    }
  }

  return null;
}
