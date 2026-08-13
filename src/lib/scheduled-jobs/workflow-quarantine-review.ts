import path from 'node:path';
import {
  selectWorkflowCandidates,
  validateWorkflowDocument,
  workflowFrontMatter,
  WorkflowDocumentValidationError,
  type WorkflowCandidate,
  type WorkflowContract,
} from './workflow-validator';

export type QuarantineReview =
  | { status: 'resolved'; candidate: WorkflowCandidate }
  | { status: 'still_failing' }
  | { status: 'missing' };

/**
 * Re-validate a quarantined workflow document against the current head. The
 * quarantined path itself may be gone (renaming the conflicting duplicate
 * away is a valid resolution), so the review key is the document NUMBER:
 * list the quarantined document's branch-space directory at head and
 * re-validate the single remaining document carrying that number. Returns
 * `resolved` only when exactly one such document exists and passes full
 * validation; persisting duplicates or invalid content keep the quarantine
 * (`still_failing`), as does a vanished number (`missing`). Runtime/git
 * errors propagate so the caller's failure accounting stays unchanged.
 */
export const reviewQuarantinedDocument = async ({
  cwd,
  head,
  failurePath,
  contract,
  git,
  signal,
}: {
  cwd: string;
  head: string;
  failurePath: string;
  contract: WorkflowContract;
  git: (...args: string[]) => Promise<string>;
  signal: AbortSignal;
}): Promise<QuarantineReview> => {
  const watchRoot = path.posix.dirname(failurePath);
  const quarantined = selectWorkflowCandidates([failurePath], contract, watchRoot)[0];
  if (!quarantined) return { status: 'missing' };
  const siblings = selectWorkflowCandidates(
    (await git('ls-tree', '-r', '--name-only', head, '--', watchRoot)).trim().split('\n').filter(Boolean),
    contract,
    watchRoot,
  ).filter((item) => item.number === quarantined.number);
  if (!siblings.length) return { status: 'missing' };
  if (contract.numbering.unique && siblings.length !== 1) return { status: 'still_failing' };
  const candidate = siblings[0];
  try {
    if (candidate.rawNumber.length !== contract.numbering.width) {
      throw new WorkflowDocumentValidationError('workflow document number has invalid width');
    }
    const content = await git('show', `${head}:${candidate.filePath}`);
    let metadata: Record<string, unknown>;
    try {
      metadata = workflowFrontMatter(content);
    } catch (error) {
      throw new WorkflowDocumentValidationError(error instanceof Error ? error.message : String(error));
    }
    await validateWorkflowDocument(
      cwd, head, candidate.filePath, candidate.type, content, metadata, contract, watchRoot, signal,
    );
  } catch (error) {
    if (error instanceof WorkflowDocumentValidationError) return { status: 'still_failing' };
    throw error;
  }
  return { status: 'resolved', candidate };
};
