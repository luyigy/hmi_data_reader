import type { AcpxPermissionSupportState } from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import type { ChatMessage } from '@/lib/websocket-client';

export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  gateway?: {
    id: string;
    name: string;
  } | null;
}
export interface AcpxParticipantSpec {
  gatewayId: string;
  gatewayName?: string;
  executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
  harnessType: string;
  harnessLabel?: string;
  role: string;
  agentId?: string;
  agentName?: string;
}
export interface TaskInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  executionMode?: 'standard' | 'acpx';
  workingDirectory?: string | null;
  acpxPermissionConfig?: AcpxPermissionConfig;
  currentTaskSession?: {
    id: string;
    status: string;
    attentionState: string;
    activeRunId?: string | null;
  } | null;
  assignedAgents: AgentInfo[];
  acpxParticipants?: AcpxParticipantSpec[];
}

export interface TaskRoomInfo {
  id: string;
  name: string;
  description?: string | null;
}

export interface TaskRoomMessageTargetOption {
  type: 'task' | 'participant' | 'all';
  participantKey?: string | null;
  participantLabel?: string | null;
  label: string;
}

export type ConversationMode = 'chat' | 'run';

export interface ConversationFeedItem {
  id: string;
  createdAt: string;
  type: 'room_message' | 'run_event';
  roomMessage?: ChatMessage;
  runEvent?: TaskRunEvent;
}

export interface StandardLogMessage {
  id: string;
  timestamp: string;
  sender: 'system' | 'agent';
  senderName?: string;
  messageType: 'info' | 'output' | 'error' | 'result';
  content: string;
}

export interface TaskRunEvent {
  id: string;
  taskRunId: string;
  participantId?: string | null;
  participant?: {
    gatewayId?: string | null;
    gatewayName: string;
    executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
    harnessType: string;
    harnessLabel?: string | null;
    role: string;
    agentId?: string | null;
    agentName?: string | null;
  } | null;
  sequence: number;
  eventType: string;
  stream: 'system' | 'stdout' | 'stderr';
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface TaskRunParticipant {
  id: string;
  gatewayId?: string | null;
  gatewayName: string;
  executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
  harnessType: string;
  harnessLabel?: string | null;
  role: string;
  agentId?: string | null;
  agentName?: string | null;
  status: string;
  activityState?: string;
  summary?: string | null;
  error?: string | null;
  filesModified: string[];
  controlMetadata?: Record<string, unknown> | null;
  interruptSupported?: boolean;
  resumeSupported?: boolean;
  sessionControlSupported?: boolean;
  softStopSupported?: boolean;
}

export interface TaskRunSummary {
  id: string;
  taskSessionId?: string | null;
  mode: string;
  orchestrationMode: string;
  status: string;
  controlState?: string;
  activityState?: string;
  summary?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  participants: Array<{
    id: string;
    gatewayId?: string | null;
    gatewayName: string;
    executionBackend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
    harnessType: string;
    role: string;
    status: string;
    interruptSupported?: boolean;
    softStopSupported?: boolean;
    resumeSupported?: boolean;
    sessionControlSupported?: boolean;
  }>;
}

export interface SelectedRunResponse {
  taskId: string;
  executionMode: 'standard' | 'acpx';
  latestRun: {
    id: string;
    taskSessionId?: string | null;
    orchestrationMode: string;
    status: string;
    controlState?: string;
    activityState?: string;
    controlMetadata?: Record<string, unknown> | null;
    summary?: string | null;
    error?: string | null;
    participants: TaskRunParticipant[];
    events: TaskRunEvent[];
  } | null;
}

export const taskRoomUser = {
  id: 'task-room-user',
  name: '用户',
};

export const permissionSupportTone: Record<AcpxPermissionSupportState, string> = {
  applied: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  partially_applied: 'bg-amber-50 text-amber-800 ring-amber-200',
  recorded_only: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export const getPermissionSupportLabel = (state: AcpxPermissionSupportState) =>
  state === 'applied'
    ? '已应用'
    : state === 'partially_applied'
    ? '部分应用'
    : '仅记录';

export const buildPermissionConfigFromProfile = (
  profile: AcpxPermissionConfig['profile'],
  currentWritableRoots: string[] = []
): AcpxPermissionConfig => {
  if (profile === 'safe_local') {
    return {
      profile,
      sandboxMode: 'workspace-write',
      networkAccess: 'restricted',
      approvalPolicy: 'never',
      writableRoots: [],
    };
  }

  if (profile === 'dev_local') {
    return {
      profile,
      sandboxMode: 'workspace-write',
      networkAccess: 'enabled',
      approvalPolicy: 'on-request',
      writableRoots: currentWritableRoots,
    };
  }

  if (profile === 'full_access') {
    return {
      profile,
      sandboxMode: 'danger-full-access',
      networkAccess: 'enabled',
      approvalPolicy: 'on-request',
      writableRoots: currentWritableRoots,
    };
  }

  return {
    profile: 'custom',
    sandboxMode: 'workspace-write',
    networkAccess: 'restricted',
    approvalPolicy: 'never',
    writableRoots: currentWritableRoots,
  };
};
