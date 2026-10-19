import { RuntimePreparationError } from '../task-graph/runtime-preflight';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AcpxPermissionConfig } from '../acpx/types';
import { projectCapabilityContext } from './context';
import { within } from './policy';
import type { RuntimeDeclarationSource } from '../task-graph/runtime-contract';
import { workflowSnapshotExtraRoots } from '../workflow-execution-policy';

/** Registered projects have one authority. Legacy registrations are consulted only for unregistered projects. */
async function resolveProjectTools(args: { taskId: string; taskRunId?: string; executionId: string; repository: string; sourceWorkspace: string;
  policyFile?: string; permissionConfig?: AcpxPermissionConfig; commit: string; declaration: RuntimeDeclarationSource | null }) {
  const context = await projectCapabilityContext({ taskId: args.taskId, workspace: args.sourceWorkspace, taskRunId: args.taskRunId, policyFile: args.policyFile, executionId: args.executionId });
  if (!context) return null;
  const policy = context.policy;
  const roots = context.policy.readOnlyRoots;
  if (args.permissionConfig && 'workflowPermissionSnapshot' in args.permissionConfig) {
    const allowed = workflowSnapshotExtraRoots(args.permissionConfig).extraReadOnlyPaths;
    if (roots.some(root => !allowed.some(scope => within(scope, root)))) throw new Error('项目工具目录超出本次显式文件权限');
  }
  const declaration = args.declaration || (policy.runtime ? {
    origin: 'host_registration' as const, registrationHash: policy.hash, declaration: policy.runtime,
    manifestHash: createHash('sha256').update(JSON.stringify(policy.runtime)).digest('hex'), commit: args.commit,
    filename: path.join('project-capabilities', policy.hash),
  } : null);
  return { policyHash: policy.hash, roots, declaration };
}

export async function approvedProjectTools(args: Parameters<typeof resolveProjectTools>[0]) {
  try { return await resolveProjectTools(args); }
  catch (error) { throw new RuntimePreparationError('invalid', error instanceof Error ? error.message : String(error), [args.repository]); }
}
