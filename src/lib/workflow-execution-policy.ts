import os from 'node:os';
import path from 'node:path';
import type { AcpxPermissionSupportState } from './acpx/permissions';
import type {
  AcpxExecutionBackend,
  AcpxHarnessType,
  AcpxPermissionConfig,
} from './acpx/types';

export type WorkflowExecutionPolicy = {
  preset: 'workspace';
};

export type WorkflowPermissionSnapshot = {
  configured: {
    preset: 'workspace';
    source: string;
  };
  effective: {
    workdir: string;
    filesystem: 'workspace_write';
    temporaryDirectory: 'isolated_per_run';
    network: 'enabled';
    approval: 'never';
    permissionConfig: AcpxPermissionConfig;
  };
  enforcement: {
    level: AcpxPermissionSupportState;
    sandboxMode: AcpxPermissionSupportState;
    approvalPolicy: AcpxPermissionSupportState;
    networkAccess: AcpxPermissionSupportState;
    writableRoots: AcpxPermissionSupportState;
    summary: string;
  };
  exceptions: Array<{
    path: string;
    access: 'read_only';
    reason: string;
  }>;
};

export const workflowPolicySource = (projectId: string, jobId: string) =>
  `config/projects.yaml#projects.${projectId}.jobs.${jobId}.config.execution_policy`;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const validateWorkflowExecutionPolicy = (
  value: unknown,
  label = 'execution_policy',
): WorkflowExecutionPolicy => {
  const policy = object(value, label);
  if (policy.preset !== 'workspace') {
    throw new Error(`${label}.preset must be workspace`);
  }
  const unsupported = Object.keys(policy).filter((key) => key !== 'preset');
  if (unsupported.length) {
    throw new Error(`${label} does not allow custom fields: ${unsupported.join(', ')}`);
  }
  return { preset: 'workspace' };
};

const enforcementLevel = (states: AcpxPermissionSupportState[]): AcpxPermissionSupportState =>
  states.every((state) => state === 'applied')
    ? 'applied'
    : states.every((state) => state === 'recorded_only')
    ? 'recorded_only'
    : 'partially_applied';

export const buildWorkflowPermissionSnapshot = ({
  policy,
  projectPath,
  source,
  harnessType = 'codex',
  executionBackend = 'platform_local',
}: {
  policy: WorkflowExecutionPolicy;
  projectPath: string;
  source: string;
  harnessType?: AcpxHarnessType;
  executionBackend?: AcpxExecutionBackend;
}): WorkflowPermissionSnapshot => {
  // Keep config-only watcher validation loadable without the app's path-alias resolver.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLocalHarnessPermissionSupport } = require('./acpx/permissions') as typeof import('./acpx/permissions');
  const support = getLocalHarnessPermissionSupport(harnessType, executionBackend);
  const states = [
    support.sandboxMode,
    support.approvalPolicy,
    support.networkAccess,
    support.writableRoots,
  ];
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return {
    configured: { preset: policy.preset, source },
    effective: {
      workdir: projectPath,
      filesystem: 'workspace_write',
      temporaryDirectory: 'isolated_per_run',
      network: 'enabled',
      approval: 'never',
      permissionConfig: {
        profile: 'custom',
        sandboxMode: 'workspace-write',
        networkAccess: 'enabled',
        approvalPolicy: 'never',
        writableRoots: [projectPath],
      },
    },
    enforcement: {
      level: enforcementLevel(states),
      sandboxMode: support.sandboxMode,
      approvalPolicy: support.approvalPolicy,
      networkAccess: support.networkAccess,
      writableRoots: support.writableRoots,
      summary: support.summary,
    },
    exceptions: [
      {
        path: codexHome,
        access: 'read_only',
        reason: 'Codex authentication, configuration, plugins, and rules',
      },
      {
        path: path.join(os.homedir(), '.agents'),
        access: 'read_only',
        reason: 'Shared Agent skills',
      },
    ],
  };
};

export const readWorkflowPermissionSnapshot = (
  value: unknown,
  expectedWorkdir: string,
): WorkflowPermissionSnapshot | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Partial<WorkflowPermissionSnapshot>;
  const effective = snapshot.effective;
  const permission = effective?.permissionConfig;
  const allowedExceptions = [
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.agents'),
  ];
  if (!permission
    || !Array.isArray(permission.writableRoots)
    || !Array.isArray(snapshot.exceptions)
    || snapshot.exceptions.length !== allowedExceptions.length
    || snapshot.exceptions.some((exception, index) =>
      exception?.access !== 'read_only' || exception.path !== allowedExceptions[index])
    || snapshot.configured?.preset !== 'workspace'
    || effective?.workdir !== expectedWorkdir
    || effective.filesystem !== 'workspace_write'
    || effective.temporaryDirectory !== 'isolated_per_run'
    || effective.network !== 'enabled'
    || effective.approval !== 'never'
    || permission?.sandboxMode !== 'workspace-write'
    || permission.networkAccess !== 'enabled'
    || permission.approvalPolicy !== 'never'
    || permission.writableRoots.length !== 1
    || permission.writableRoots[0] !== expectedWorkdir) {
    throw new Error('invalid Workflow permission snapshot');
  }
  return snapshot as WorkflowPermissionSnapshot;
};

export const resolveWorkflowCodexBoundary = (
  permission: AcpxPermissionConfig | undefined,
  expectedWorkdir: string,
  currentCodexHome?: string,
) => {
  const snapshot = readWorkflowPermissionSnapshot(
    (permission as AcpxPermissionConfig & { workflowPermissionSnapshot?: unknown } | undefined)
      ?.workflowPermissionSnapshot,
    expectedWorkdir,
  );
  if (!snapshot) return null;
  return {
    workingDirectory: snapshot.effective.workdir,
    workspaceRoot: snapshot.effective.workdir,
    networkAccess: snapshot.effective.network,
    // Bubblewrap is the Workflow filesystem boundary; Codex workspace-write makes .git read-only.
    sandboxMode: 'danger-full-access',
    approvalPolicy: snapshot.effective.approval,
    readOnlyPaths: snapshot.exceptions.map((exception) => exception.path),
    codexHome: path.join(
      snapshot.effective.workdir,
      '.git',
      'agent-platform',
      'codex',
      path.basename(currentCodexHome || 'workflow'),
    ),
  } as const;
};

export const applyWorkflowPermissionSnapshot = (
  permission: AcpxPermissionConfig,
  snapshot: WorkflowPermissionSnapshot | null,
): AcpxPermissionConfig => snapshot
  ? { ...snapshot.effective.permissionConfig, workflowPermissionSnapshot: snapshot } as AcpxPermissionConfig
  : permission;

export const formatWorkflowPermissionSnapshot = (snapshot: WorkflowPermissionSnapshot) => [
  `configured: preset=${snapshot.configured.preset} · source=${snapshot.configured.source}`,
  `effective: workdir=${snapshot.effective.workdir} · filesystem=${snapshot.effective.filesystem} · temp=${snapshot.effective.temporaryDirectory} · network=${snapshot.effective.network} · approval=${snapshot.effective.approval}`,
  `enforcement: ${snapshot.enforcement.level} · sandbox=${snapshot.enforcement.sandboxMode} · approval=${snapshot.enforcement.approvalPolicy} · network=${snapshot.enforcement.networkAccess} · writable_roots=${snapshot.enforcement.writableRoots}`,
  'exceptions:',
  ...snapshot.exceptions.map((exception) =>
    `- ${exception.path} · ${exception.access} · ${exception.reason}`),
].join('\n');
