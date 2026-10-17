import { loadSpecPackage } from './spec-package';
import { buildIssueGraph } from './issue-route';
import { createGraphProposal } from './proposals';
import { prepareExistingIssueAdoption } from './issue-adoption';

/** Selection invokes deterministic Issue import, not an Agent-authored dependency graph. */
export async function proposeIssueSpec(args: { repository: string; commit: string; manifestPath: string; parentTaskId: string; createdBy: string; version?: number }) {
  const item = await loadSpecPackage(args.repository, args.commit, args.manifestPath);
  if (!item?.issueRoute) throw new Error('请选择 Issue-backed Spec 包；历史 JSON 路线只供现有运行回读');
  const definition = item.issueRoute.existingRun
    ? await prepareExistingIssueAdoption({ ...item.issueRoute.existingRun, parentTaskId: args.parentTaskId, parent: item.issueRoute.parent, repositories: item.issueRoute.repositories })
    : await buildIssueGraph(`${item.repository}/${item.specPath}@${item.commit}`, item.issueRoute);
  definition.specPackage = { repository: item.repository, commit: item.commit, manifestPath: item.manifestPath, hash: item.hash };
  return createGraphProposal({ parentTaskId: args.parentTaskId, createdBy: args.createdBy, version: args.version, definition });
}
