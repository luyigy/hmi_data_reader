import { graphGit } from './git-command';
import { withRepositoryLock } from './repository-lock';
import { integrateJobWorktree, TaskGraphGitError, type IntegrationRequest } from './worktree';

/** Caller persists each retry and supplies the remaining budget from execution progress. */
export async function integrateJobWithRetry(request: IntegrationRequest & {
  assertOwnership: () => Promise<void>;
  maxAttempts: number;
  onRetry: (failure: TaskGraphGitError, attempt: number) => Promise<void>;
}) {
  if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 3) {
    throw new Error('Integration attempt budget must be between one and three');
  }
  let expectedIntegrationCommit = request.expectedIntegrationCommit;
  for (let attempt = 1; attempt <= request.maxAttempts; attempt++) {
    try {
      return await withRepositoryLock(request.repoPath, async () => {
        await request.assertOwnership();
        if (attempt > 1) expectedIntegrationCommit = await graphGit(request.repoPath, 'rev-parse', '--verify', `${request.integrationRef}^{commit}`);
        return integrateJobWorktree({ ...request, expectedIntegrationCommit });
      });
    } catch (error) {
      if (!(error instanceof TaskGraphGitError) || error.code !== 'integration_stale' || error.integration?.kind !== 'stale' ||
          error.integration.integrationCommit === error.integration.expectedIntegrationCommit) throw error;
      await request.assertOwnership();
      await request.onRetry(error, attempt);
      if (attempt === request.maxAttempts) {
        throw new TaskGraphGitError('integration_retry_exhausted', 'Integration reference retry budget exhausted; preserve current candidate', error.workspacePath,
          { cause: error }, { kind: 'retry_exhausted', attempts: attempt, lastFailure: error.integration });
      }
    }
  }
  throw new Error('Integration attempt budget was not consumed');
}
