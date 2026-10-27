export type TaskExecutionMode = 'standard' | 'acpx';
export type AcpxHarnessType = 'codex' | 'claude' | 'gemini-cli' | string;
export type AcpxExecutionBackend = 'platform_local' | 'gateway_openclaw' | 'remote_ssh';
export type RunControlAction = 'queue_message' | 'interrupt_now' | 'stop_run' | 'continue_session';
export type RunControlDeliveryMode = 'queued' | 'immediate';
export type RunControlDeliveryStatus = 'pending' | 'delivered' | 'superseded' | 'rejected';
export type RunControlState = 'normal' | 'interrupt_requested' | 'stop_requested';
export type AcpxParticipantRole =
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'researcher'
  | 'custom';
export type AcpxOrchestrationMode = 'single' | 'staged';
export type TaskRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_input'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'stopped';
export type RunActivityState = 'streaming' | 'quiet' | 'stalled' | 'waiting_user' | 'terminating';
export type TaskRunEventType =
  | 'runner_started'
  | 'participant_started'
  | 'session_continuation_started'
  | 'control_message'
  | 'interaction_request_created'
  | 'interaction_request_resolved'
  | 'stdout_chunk'
  | 'stderr_chunk'
  | 'subagent_started'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'summary'
  | 'file_modified'
  | 'participant_interrupted'
  | 'participant_stopped'
  | 'participant_completed'
  | 'participant_failed'
  | 'run_interrupted'
  | 'run_stopped'
  | 'run_completed'
  | 'run_failed';
export type TaskRunStream = 'system' | 'stdout' | 'stderr';
export type TaskRunEventTier = 'summary' | 'detail';
export type HarnessInteractionRequestKind =
  | 'permission_request'
  | 'input_request'
  | 'choice_request'
  | 'workspace_issue';

export type TaskRunInteractionRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'answered'
  | 'expired'
  | 'cancelled';

export interface HarnessCapability {
  supportsQueuedUserMessages: boolean;
  supportsImmediateInterrupt: boolean;
  supportsResumeAfterInterrupt: boolean;
  supportsLiveSessionControl: boolean;
  supportsSoftStop: boolean;
}

export interface WatchdogConfig {
  maxRuntimeMs?: number | null;
  inactivityWarningMs?: number | null;
  inactivityFailMs?: number | null;
}

export interface AcpxPermissionConfig {
  profile: 'safe_local' | 'dev_local' | 'full_access' | 'custom';
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  networkAccess: 'restricted' | 'enabled';
  approvalPolicy: 'never' | 'on-request';
  writableRoots: string[];
}

export interface AcpxParticipantRequest {
  gatewayId: string;
  gatewayName?: string;
  executionBackend: AcpxExecutionBackend;
  harnessType: AcpxHarnessType;
  harnessLabel?: string;
  role: AcpxParticipantRole | string;
  agentId?: string;
  agentName?: string;
  continuationKey?: string;
  resumeSessionId?: string;
  continuationSessionKind?: string;
  resumeThreadId?: string;
  continuationMessage?: string;
  ephemeralSession?: boolean;
  codexHome?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface AcpxRunRequest {
  graphAssociation?: import('../task-graph/graph-association').GraphAssociation;
  resourceContinuation?: { approvalId: string; revision: number };
  graphReview?: { runId: string; nodeId: string; phase: 'architecture' | 'acceptance'; claimKey: string };
  graphExecution?: { executionId: string; claimToken: string; revision: number; inputIds?: string[] };
  graphConversation?: { executionId: string; reservationId: string; inputIds: string[] };
  taskId: string;
  taskSessionId?: string;
  taskName: string;
  taskDescription?: string;
  workflowCompletionGate?: boolean;
  orchestrationMode: AcpxOrchestrationMode;
  participants: AcpxParticipantRequest[];
  workingDirectory?: string;
  extraReadOnlyPaths?: string[];
  permissionConfig?: AcpxPermissionConfig;
  watchdogConfig?: WatchdogConfig;
  streamCallbacks?: HarnessStreamCallbacks;
}

export interface AcpxLiveEventPayload {
  id: string;
  taskId: string;
  taskRunId: string;
  participantId?: string | null;
  participant?: {
    gatewayId?: string | null;
    gatewayName: string;
    executionBackend: AcpxExecutionBackend;
    harnessType: string;
    harnessLabel?: string | null;
    role: string;
    agentId?: string | null;
    agentName?: string | null;
  } | null;
  sequence: number;
  eventType: TaskRunEventType;
  stream: TaskRunStream;
  tier: TaskRunEventTier;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface HarnessToolEvent {
  status?: 'completed' | 'failed';
  toolCallId?: string;
  exitCode?: number;
  toolName: string;
  preview: string;
  emoji: string;
}

export interface HarnessSubagentEvent {
  taskId: string;
  agentId?: string;
  description: string;
  status: string;
  ordinal?: number;
  limit?: number;
  subagentType?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  output?: string;
}

export interface HarnessStreamCallbacks {
  onSessionSize?: (sample: import('../session-size').SessionSizeSample) => Promise<void> | void;
  onRunStarted?: (taskRunId: string) => Promise<void> | void;
  // Present only for executions whose owner supports running-message delivery.
  onSteeringReady?: (steer: HarnessSteer) => () => void;
  onStdoutChunk?: (chunk: string, message?: import('../agent-reply-state').AgentMessageInfo) => Promise<void> | void;
  onStderrChunk?: (chunk: string) => Promise<void> | void;
  onToolEvent?: (event: HarnessToolEvent) => Promise<void> | void;
  onSubagentEvent?: (event: HarnessSubagentEvent) => Promise<void> | void;
  onCodexTokenUsage?: (usage: import('@/lib/codex-telemetry').CodexProviderTokenUsage) => Promise<void> | void;
  onCodexRateLimits?: (event: {
    rateLimits: unknown;
    snapshot: boolean;
    collectedAt: Date;
  }) => Promise<void> | void;
  onInteractionRequest?: (
    request: HarnessInteractionRequest
  ) => Promise<'approve' | 'deny'>;
}

export type HarnessSteer = (messageId: string, message: string) => Promise<'accepted' | 'rejected' | 'unknown'>;

export interface HarnessInteractionRequest {
  nativePermission?: {
    method: string;
    scope: 'operation' | 'turn';
    grantRoot?: string;
    permissions?: unknown;
  };
  kind: HarnessInteractionRequestKind;
  message: string;
  rawContent: string;
  title?: string;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  defaultOptionId?: string | null;
  responseFormat?: 'approve_deny' | 'text' | 'single_choice';
  resumeStrategy?: 'in_process' | 'rerun_continuation' | 'restart_required';
}

export interface TaskRunControlMessageDraft {
  taskId: string;
  taskSessionId?: string | null;
  taskRunId: string;
  roomMessageId?: string | null;
  participantId?: string | null;
  senderUserId: string;
  senderName: string;
  deliveryMode: RunControlDeliveryMode;
  deliveryStatus?: RunControlDeliveryStatus;
  controlAction: RunControlAction;
  content: string;
  metadata?: Record<string, unknown> | null;
}
