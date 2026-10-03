import { handleFeishuBroadcastCommand } from '@/lib/feishu-broadcast-command';
import { handleFeishuTaskCommand } from '@/lib/feishu-task-entry';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import {
  commandRequestsFullAccess,
  handleFeishuUserManagementCommand,
  requestFullAccessApproval,
} from '@/lib/feishu-access-approval';
import { handleScheduledJobCommand } from '@/lib/feishu-scheduled-jobs';
import { handleAgentSessionsCommand, handleStopAgentCommand } from '@/lib/feishu-agent-sessions';
import { handleFeishuPlanCommand } from '@/lib/feishu-plan';
import { handleFeishuDocumentCommand } from '@/lib/feishu-document-command';
import { handleFeishuMarkdownCommand } from '@/lib/feishu-markdown-picker';
import { handleWorkflowPolicyCommand } from '@/lib/feishu-workflow-policy';
import { handleWorkflowInboxCommand } from '@/lib/feishu-workflow-inbox';
import { formatFeishuHelp, sendFeishuCommandCenter } from '@/lib/feishu-help';
import { handleNewSessionCommand } from '@/lib/feishu-new-session';
import { handleRoomRestrictionCommand } from '@/lib/feishu-room-controls';
import {
  handleAgentsCommand,
  handleGatewaysCommand,
  handleHostsCommand,
  handleRegisterCommand,
  handleRunCommand,
  handleStatusCommand,
} from '@/lib/feishu-runtime-commands';
import {
  handleAddCommand,
  handleCodexConfigCommand,
  handleHandoffLimitCommand,
  handleKickCommand,
  handleMembersCommand,
  handleModeCommand,
  handleNickCommand,
  handleRoleCommand,
  handleSpecialtyCommand,
  handleRoomCommand,
  handleSpeakerCommand,
  handleTimeoutCommand,
} from '@/lib/feishu-live-room-commands';
import {
  handleApproveLikeCommand,
  handleApprovalsCommand,
  handleChatCommand,
  handleGrantCommand,
  handleHandoverCommand,
  handleRightsCommand,
  handleWorkspaceCommand,
} from '@/lib/feishu-task-commands';

export { parseFeishuCommand } from '@/lib/feishu-command-parser';
export { hydrateFeishuMessageResources, parseFeishuMessageContent } from '@/lib/feishu-message-content';
export {
  getFeishuChallengeResponse,
  normalizeFeishuPayload,
  parseFeishuMessage,
  validateFeishuRequestSignature,
  validateFeishuVerificationToken,
} from '@/lib/feishu-webhook';

import { handleBranchCommand } from '@/lib/feishu-branch-command';

export async function handleFeishuCommand(args: {
  command: ParsedFeishuCommand;
  baseUrl: string;
  context?: FeishuConversationContext;
  adminApproved?: boolean;
}) {
  if (args.context && commandRequestsFullAccess(args.command) && !args.adminApproved) {
    return requestFullAccessApproval({ command: args.command, baseUrl: args.baseUrl, context: args.context });
  }
  switch (args.command.command) {
    case 'help':
      return formatFeishuHelp(args.command);
    case 'menu':
      return sendFeishuCommandCenter(args.context);
    case 'status':
      return handleStatusCommand(args.command, args.context);
    case 'users':
    case 'user':
      return handleFeishuUserManagementCommand({ command: args.command, senderOpenId: args.context?.senderOpenId });
    case 'gateways':
      return handleGatewaysCommand();
    case 'agents':
    case 'discover-agents':
      return handleAgentsCommand(args.command);
    case 'hosts':
      return handleHostsCommand();
    case 'run':
      return handleRunCommand(args.command);
    case 'register':
      return handleRegisterCommand(args.command);
    case 'broadcast':
      return handleFeishuBroadcastCommand(args.command, args.context);
    case 'isolation':
    case 'task':
      return handleFeishuTaskCommand(args.command, args.context);
    case 'room':
      return handleRoomCommand(args.command, args.context);
    case 'handoff-limit':
      return handleHandoffLimitCommand(args.command, args.context);
    case 'timeout':
      return handleTimeoutCommand(args.command, args.context);
    case 'mode':
      return handleModeCommand(args.command, args.context);
    case 'members':
      return handleMembersCommand(args.context);
    case 'nick':
      return handleNickCommand(args.command, args.context);
    case 'role':
      return handleRoleCommand(args.command, args.context);
    case 'specialty':
      return handleSpecialtyCommand(args.command, args.context);
    case 'restrict':
      return handleRoomRestrictionCommand(args.command, args.context);
    case 'model-config':
    case 'codex-config':
      return handleCodexConfigCommand(args.command, args.context);
    case 'speaker':
      return handleSpeakerCommand(args.command, args.context);
    case 'kick':
      return handleKickCommand(args.command, args.context);
    case 'add':
      return handleAddCommand(args.command, args.context);
    case 'chat':
      return handleChatCommand(args.command, args.baseUrl, args.context);
    case 'plan':
      return handleFeishuPlanCommand(args.command, args.context);
    case 'doc':
      return handleFeishuDocumentCommand(args.command, args.context);
    case 'md':
      return handleFeishuMarkdownCommand(args.command, args.context);
    case 'approvals':
      return handleApprovalsCommand(args.context);
    case 'approve':
      return handleApproveLikeCommand({ command: args.command, context: args.context, action: 'approve' });
    case 'deny':
      return handleApproveLikeCommand({ command: args.command, context: args.context, action: 'deny' });
    case 'answer':
      return handleApproveLikeCommand({ command: args.command, context: args.context, action: 'answer' });
    case 'grant':
      return handleGrantCommand(args.command, args.context, args.adminApproved);
    case 'rights':
      return handleRightsCommand(args);
    case 'handover':
      return handleHandoverCommand(args.command, args.context);
    case 'workspace':
      return handleWorkspaceCommand(args.command, args.context);
    case 'jobs':
    case 'job':
      return handleScheduledJobCommand(args.command, args.context);
    case 'workflow':
      return handleWorkflowPolicyCommand(args.command, args.context);
    case 'inbox':
      return handleWorkflowInboxCommand(args.command, args.context);
    case 'new-session':
      return handleNewSessionCommand(args.command, args.context);
    case 'stop': return handleStopAgentCommand(args.command, args.context);
    case 'sessions': return handleAgentSessionsCommand();
    case 'branch': return handleBranchCommand(args.command, args.context);
    default:
      return formatFeishuHelp(args.command);
  }
}
