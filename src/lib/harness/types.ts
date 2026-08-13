import type { ChildProcess } from 'child_process';
import type {
  AcpxExecutionBackend,
  AcpxPermissionConfig,
  HarnessCapability,
  HarnessStreamCallbacks,
} from '@/lib/acpx/types';
import type { AcpxPermissionSupportSummary } from '@/lib/acpx/permissions';

export interface HarnessTask {
  id: string;
  name: string;
  description?: string;
}

export interface HarnessSessionStarted {
  sessionId: string;
  sessionKind: string;
  threadId?: string;
}

export interface HarnessExecutionContext {
  workingDirectory: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  extraReadOnlyPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
  executionBackend: AcpxExecutionBackend;
  permissionConfig?: AcpxPermissionConfig;
  timeout: number | null;
  ephemeralSession?: boolean;
  codexHome?: string;
  model?: string;
  reasoningEffort?: string;
  sessionKey?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onSessionStarted?: (session: HarnessSessionStarted) => Promise<void> | void;
}

export interface HarnessExecuteArgs {
  task: HarnessTask;
  context: HarnessExecutionContext;
}

export interface HarnessResumeArgs {
  task: HarnessTask;
  context: HarnessExecutionContext;
  sessionId: string;
  continuationMessage: string;
}

import type { AntigravityContextUsage } from '@/lib/real-agents/antigravity-context';

export interface HarnessExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
  liveStreaming?: boolean;
  contextUsage?: AntigravityContextUsage;
}

export interface HarnessAvailability {
  available: boolean;
  version?: string;
}

export interface HarnessContinuationDescriptor {
  sessionId: string | null;
  sessionKind: string | null;
}

export interface HarnessAdapter {
  type: string;
  displayName: string;
  checkAvailability(): Promise<HarnessAvailability>;
  execute(args: HarnessExecuteArgs): Promise<HarnessExecuteResult>;
  resume?(args: HarnessResumeArgs): Promise<HarnessExecuteResult>;
  getCapabilities(executionBackend: AcpxExecutionBackend): HarnessCapability;
  getPermissionSupport(executionBackend: AcpxExecutionBackend): AcpxPermissionSupportSummary;
  readContinuation?(metadata: Record<string, unknown>): HarnessContinuationDescriptor;
  isInvalidContinuationError?(message: string): boolean;
}
