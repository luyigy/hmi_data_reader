import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AcpxPermissionConfig } from './types';
import { validateWorkflowExecutionPolicy, workflowSnapshotExtraRoots } from '../workflow-execution-policy';

// Host-managed configuration, never read from the task's working directory.
// Exact workspace matches share runtime access, not conversation or full_access.
export function resolveLocalRuntimeReadOnlyPaths(
  workingDirectory: string,
  permission: AcpxPermissionConfig,
  file = path.join(process.cwd(), 'config/runtime-environments.json'),
): string[] {
  if ('workflowPermissionSnapshot' in permission) {
    return workflowSnapshotExtraRoots(permission).extraReadOnlyPaths;
  }
  if (permission.profile === 'full_access') return [];
  let source: unknown;
  try {
    source = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('runtime-environments must map absolute workspaces to read-only paths');
  }
  const workspace = realpathSync(workingDirectory);
  const roots: string[] = [];
  for (const [directory, paths] of Object.entries(source)) {
    const policy = validateWorkflowExecutionPolicy({
      preset: 'workspace', extraWritableRoots: [directory], extraReadOnlyPaths: paths,
    }, 'runtime-environments');
    let configuredWorkspace: string;
    try {
      configuredWorkspace = realpathSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (policy.preset !== 'workspace' || configuredWorkspace !== workspace) continue;
    for (const entry of policy.extraReadOnlyPaths ?? []) {
      const resolved = realpathSync(entry);
      if (resolved === '/' || !statSync(resolved).isDirectory()) {
        throw new Error(`Invalid runtime read-only directory: ${entry}`);
      }
      // Bubblewrap binds canonical paths; reject aliases rather than mount a
      // different path from the one the virtual environment actually uses.
      if (resolved !== entry) throw new Error(`Use canonical runtime path: ${resolved}`);
      roots.push(resolved);
    }
  }
  return Array.from(new Set(roots));
}
