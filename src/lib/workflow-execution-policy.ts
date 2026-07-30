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

const WORKFLOW_CODEX_INNER_SANDBOX_MODE = 'danger-full-access';

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
    sandboxMode: WORKFLOW_CODEX_INNER_SANDBOX_MODE,
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

export const formatWorkflowPermissionSnapshot = (snapshot: WorkflowPermissionSnapshot) => {
  const stateLabel = {
    applied: '已生效',
    partially_applied: '部分生效',
    recorded_only: '仅记录，未强制执行',
  } as const;
  const conclusion = snapshot.enforcement.level === 'applied'
    ? '所有权限限制均已生效'
    : snapshot.enforcement.level === 'partially_applied'
      ? '部分权限限制未完全生效，请联系管理员检查'
      : '权限策略目前仅被记录，尚未强制执行';

  return [
    `结论：Workflow 正在使用“工作区隔离”策略，${conclusion}。`,
    '',
    '**实际权限**',
    `- 工作目录：${snapshot.effective.workdir}`,
    '- 文件写入：仅允许写入上述工作区',
    '- 网络访问：允许',
    '- 临时目录：每次运行独立，运行结束后不复用',
    '- 运行中审批：不弹出审批（approval=never）',
    '',
    '**隔离边界**',
    '- 外层：Bubblewrap 工作区沙箱',
    `- Codex 内层：完全访问模式（${WORKFLOW_CODEX_INNER_SANDBOX_MODE}），但不能越过外层工作区沙箱`,
    `- 沙箱：${stateLabel[snapshot.enforcement.sandboxMode]}`,
    `- 审批策略：${stateLabel[snapshot.enforcement.approvalPolicy]}`,
    `- 网络策略：${stateLabel[snapshot.enforcement.networkAccess]}`,
    `- 可写目录限制：${stateLabel[snapshot.enforcement.writableRoots]}`,
    '',
    '**只读系统目录**',
    ...snapshot.exceptions.map((exception) =>
      `- ${exception.path}：只读；${exception.reason === 'Shared Agent skills'
        ? '共享 Agent Skills'
        : 'Codex 认证、配置、插件和规则'}`),
    '',
    '**配置位置**',
    `- 策略预设：工作区隔离（${snapshot.configured.preset}）`,
    `- 配置来源：${snapshot.configured.source}`,
  ].join('\n');
};
