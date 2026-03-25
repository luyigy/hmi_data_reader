export interface Agent {
  id: string;
  name: string;
  runtimeAgentId?: string;
  type: string;
  location?: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy' | 'error';
  lastHeartbeat: string;
  gatewayId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayAgentSummary {
  id: string;
  name: string;
  runtimeAgentId?: string;
  type: string;
  status: 'online' | 'offline' | 'busy' | 'error';
}

export interface Gateway {
  id: string;
  name: string;
  url?: string;  // Gateway API URL
  ip?: string;  // Legacy field
  status: 'online' | 'offline' | 'maintenance';
  resources?: GatewayResources;
  agentCount?: number;
  hasToken?: boolean;
  hasOpenClawToken?: boolean;
  agents?: GatewayAgentSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface GatewayResources {
  cpu: number;
  memory: number;
  disk: number;
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  assignedAgents: Agent[];
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  totalAgents: number;
  onlineAgents: number;
  busyAgents: number;
  offlineAgents: number;
}

export interface LiveRoomCatalogAgent {
  id: string;
  agentRecordId?: string | null;
  gatewayId: string;
  gatewayName: string;
  backend: 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
  harnessType: string;
  label: string;
  agentName?: string;
  runtimeAgentId?: string;
  status: string;
}

export interface LiveRoomMember {
  id: string;
  roomId: string;
  memberType: string;
  displayName: string;
  agentNameSnapshot?: string | null;
  harnessType?: string | null;
  backend?: string | null;
  runtimeAgentId?: string | null;
  roleLabel?: string | null;
  joinStatus: string;
  presenceStatus: string;
  canReply: boolean;
  sortOrder: number;
  gatewayId?: string | null;
  gatewayName?: string | null;
  agentRecordId?: string | null;
}

export interface LiveRoomMessage {
  id: string;
  roomId: string;
  senderMemberId?: string | null;
  senderName: string;
  senderLabel?: string;
  senderType: string;
  content: string;
  messageType: string;
  visibility: string;
  topicSnapshot?: string | null;
  createdAt: string;
  replyToMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface LiveRoomSummary {
  id: string;
  title: string;
  description?: string | null;
  currentTopic?: string | null;
  mode: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  currentSpeakerMemberId?: string | null;
  currentSpeakerName?: string | null;
  memberCount: number;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
}

export interface LiveRoomDetail extends LiveRoomSummary {
  sourceTask?: {
    id: string;
    name: string;
  } | null;
  pendingReplyCount?: number;
  pendingReplyTargetNames?: string[];
  pendingReplies?: Array<{
    memberId: string;
    displayName: string;
    pendingCount: number;
    oldestPendingAt: string;
    newestPendingAt: string;
    newestPendingAgeSeconds: number;
    lastProgressAt?: string | null;
    lastProgressAgeSeconds?: number | null;
    progressLabel?: string | null;
    status: 'running' | 'stalled';
  }>;
  members: LiveRoomMember[];
}
