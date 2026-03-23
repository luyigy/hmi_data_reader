export type TaskExecutionMode = 'standard' | 'acpx';
export type AcpxHarnessType = 'codex' | 'claude' | 'gemini-cli' | string;
export type AcpxExecutionBackend = 'platform_local' | 'gateway_openclaw';
export type AcpxParticipantRole =
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'researcher'
  | 'custom';
export type AcpxOrchestrationMode = 'single' | 'staged';
export type TaskRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type TaskRunEventType =
  | 'runner_started'
  | 'participant_started'
  | 'stdout_chunk'
  | 'stderr_chunk'
  | 'summary'
  | 'file_modified'
  | 'participant_completed'
  | 'participant_failed'
  | 'run_completed'
  | 'run_failed';
export type TaskRunStream = 'system' | 'stdout' | 'stderr';

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
  taskName: string;
  taskDescription?: string;
  orchestrationMode: AcpxOrchestrationMode;
  participants: AcpxParticipantRequest[];
  workingDirectory?: string;
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
