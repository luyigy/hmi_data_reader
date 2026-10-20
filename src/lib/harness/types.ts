import type { withSandbox } from '../sandbox-manager';
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

export interface HarnessSandbox {
  run: typeof withSandbox;
}

export interface HarnessExecutionContext {
  sandbox?: HarnessSandbox;
  /** Platform execution correlation; adapters must bind native evidence to this invocation. */
  executionId?: string;
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
  runtimeHome?: string;
  taskEnvironment?: Record<string, string>;
  model?: string;
  reasoningEffort?: string;
  sessionKey?: string;
  streamCallbacks?: HarnessStreamCallbacks;
  onContextUsage?: (usage: NormalizedContextUsage) => Promise<void> | void;
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

export interface NormalizedContextUsage {
  /** Provider-reported values only; never copy requested settings here. */
  model?: string;
  outputTokens?: number;
  usedTokens: number;
  /** Full session input + output spend, when the provider exposes enough data. */
  totalTokens?: number;
  contextWindow?: number;
  /** The 1M fallback is an estimate, never a provider reported limit. */
  isDefaultWindow?: boolean;
  usagePercentage?: number;
  metricKind: 'turn_input' | 'session_context' | 'cumulative';
  confidence: 'measured_exact' | 'inferred_text' | 'assumed_window';
  sessionId?: string;
  collectedAt: number;
}

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
  contextUsage?: NormalizedContextUsage;
  runtimeState?: HarnessRuntimeState;
}

/** Confirmed native state only. Never populate from requested settings or defaults. */
export interface HarnessRuntimeState {
  executionId: string;
  sessionId: string;
  turnId?: string;
  model?: string;
  modelKind?: 'model_id' | 'alias';
  provider?: string;
  reasoning: { kind: 'level'; value: string } | { kind: 'toggle'; enabled: boolean }
    | { kind: 'not_applicable' } | { kind: 'unknown' };
  source: string;
  evidence: 'runner' | 'provider';
  /** Native observation time, not the time an old file was read. */
  observedAt: number;
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
