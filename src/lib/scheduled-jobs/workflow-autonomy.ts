import type { JobConfig } from './project-config';

export const WORKFLOW_AUTONOMY_MODES = ['manual', 'semi_auto', 'auto'] as const;
export type WorkflowAutonomy = typeof WORKFLOW_AUTONOMY_MODES[number];
export const WORKFLOW_ROLE_LEVELS = ['full', 'lean', 'fast'] as const;
export type WorkflowRoleLevel = typeof WORKFLOW_ROLE_LEVELS[number];
export type WorkflowAdvance = 'revision' | 'start_first_slice' | 'next_slice' | 'resume_parent';

export type StoredWorkflowAutonomy = {
  mode: WorkflowAutonomy;
  roleWorkflowLevel?: WorkflowRoleLevel;
  expectedHead: string;
  requestId: string;
  updatedBy: string;
  updatedAt: string;
};

export const isWorkflowAutonomy = (value: unknown): value is WorkflowAutonomy =>
  WORKFLOW_AUTONOMY_MODES.includes(value as WorkflowAutonomy);

export const isWorkflowRoleLevel = (value: unknown): value is WorkflowRoleLevel =>
  WORKFLOW_ROLE_LEVELS.includes(value as WorkflowRoleLevel);

export const configuredWorkflowAutonomy = (job: JobConfig): WorkflowAutonomy => {
  const value = job.config.workflow_autonomy;
  if (value === undefined) return 'manual';
  if (!isWorkflowAutonomy(value)) throw new Error(`job ${job.id}.config.workflow_autonomy is invalid`);
  return value;
};

export const storedWorkflowAutonomy = (value: unknown): StoredWorkflowAutonomy | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (!isWorkflowAutonomy(stored.mode)
    || typeof stored.expectedHead !== 'string'
    || typeof stored.requestId !== 'string'
    || typeof stored.updatedBy !== 'string'
    || typeof stored.updatedAt !== 'string') return null;
  return stored as StoredWorkflowAutonomy;
};

export const resolveWorkflowAutonomy = (job: JobConfig, stored: unknown) => {
  if (stored === null || stored === undefined) {
    return { mode: configuredWorkflowAutonomy(job), source: 'config' as const };
  }
  const override = storedWorkflowAutonomy(stored);
  return override
    ? { mode: override.mode, source: 'override' as const, override }
    : { mode: 'manual' as const, source: 'safe_fallback' as const };
};

export const storedWorkflowRoleLevel = (stored: unknown) => {
  const level = storedWorkflowAutonomy(stored)?.roleWorkflowLevel;
  return isWorkflowRoleLevel(level) ? level : undefined;
};

export const resolveWorkflowRoleLevel = (stored: unknown, fallback: WorkflowRoleLevel = 'fast') =>
  storedWorkflowRoleLevel(stored) ?? fallback;

export const workflowPreferencesWithRoleLevel = (args: {
  job: JobConfig;
  stored: unknown;
  level: WorkflowRoleLevel;
  expectedHead: string;
  requestId: string;
  updatedBy: string;
  updatedAt?: string;
}): StoredWorkflowAutonomy => ({
  ...(storedWorkflowAutonomy(args.stored) ?? {
    mode: resolveWorkflowAutonomy(args.job, args.stored).mode,
  }),
  roleWorkflowLevel: args.level,
  expectedHead: args.expectedHead,
  requestId: args.requestId,
  updatedBy: args.updatedBy,
  updatedAt: args.updatedAt ?? new Date().toISOString(),
});

export const workflowAutonomyAllows = (
  mode: WorkflowAutonomy,
  advance: string,
  trigger: string,
) => ['revision', 'start_first_slice', 'next_slice', 'resume_parent'].includes(advance)
  && (trigger === 'manual'
    || mode === 'auto'
    || (mode === 'semi_auto'
      && advance !== 'resume_parent'));

export const canManageWorkflowAutonomy = (
  actorOpenId: string,
  admin: boolean,
  approverOpenIds: string[],
) => admin || approverOpenIds.includes(actorOpenId);

export const decideWorkflowAutonomyChange = (args: {
  currentMode: WorkflowAutonomy;
  currentHead: string;
  expectedHead: string;
  requestedMode: WorkflowAutonomy;
}) => args.currentHead !== args.expectedHead
  ? 'stale' as const
  : args.currentMode === args.requestedMode
    ? 'unchanged' as const
    : 'update' as const;
