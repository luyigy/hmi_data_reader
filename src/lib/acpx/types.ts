export type TaskExecutionMode = 'standard' | 'acpx';
export type AcpxHarnessType = 'codex' | 'claude' | 'gemini-cli' | string;
export type AcpxExecutionBackend = 'platform_local' | 'gateway_openclaw';
export type RunControlAction = 'queue_message' | 'interrupt_now' | 'stop_run';
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
  | 'control_message'
  | 'stdout_chunk'
  | 'stderr_chunk'
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

export interface AcpxParticipantRequest {
  gatewayId: string;
  gatewayName?: string;
  executionBackend: AcpxExecutionBackend;
  harnessType: AcpxHarnessType;
  harnessLabel?: string;
  role: AcpxParticipantRole | string;
  agentId?: string;
  agentName?: string;
}

export interface AcpxRunRequest {
  taskId: string;
  taskSessionId?: string;
  taskName: string;
  taskDescription?: string;
  orchestrationMode: AcpxOrchestrationMode;
  participants: AcpxParticipantRequest[];
  workingDirectory?: string;
  watchdogConfig?: WatchdogConfig;
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
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface HarnessStreamCallbacks {
  onStdoutChunk?: (chunk: string) => Promise<void> | void;
  onStderrChunk?: (chunk: string) => Promise<void> | void;
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
