import { readIssueRoute } from './issue-source';
import { trackerRequest, type TrackerRequest } from './issue-tracker';
import { validateTaskGraphDefinition, type GraphDefinition, type GraphNode } from './domain';

export type IssueRouteSettings = {
  parent: string; repositories?: string[];
  slices?: Record<string, Pick<GraphNode, 'acceptance' | 'executions' | 'executionMode' | 'architectureReview' | 'consumeUpstream' | 'services' | 'extraRepositories'>>;
  existingRun?: { runId: string; snapshotHash: string };
};

export async function buildIssueGraph(specRef: string, settings: IssueRouteSettings, request: TrackerRequest = trackerRequest): Promise<GraphDefinition> {
  if (!settings || typeof settings !== 'object' || settings.existingRun || typeof settings.parent !== 'string' || !settings.slices
    || typeof settings.slices !== 'object' || Array.isArray(settings.slices)) throw new Error('Invalid Issue execution settings');
  const { tickets, source } = await readIssueRoute(settings.parent, settings.repositories, request);
  const slices = settings.slices;
  const keys = new Set(tickets.map((ticket) => ticket.key));
  if (Object.keys(slices).some((key) => !keys.has(key)) || tickets.some((ticket) => !slices[ticket.key])) throw new Error('Issue tickets and execution settings do not match');
  const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket.key]));
  const nodes = tickets.map((ticket): GraphNode => {
    const configured = slices[ticket.key];
    if ('dependsOn' in configured || 'goal' in configured || 'key' in configured) throw new Error('Dependencies and goals must come from Issues, not execution settings');
    return { ...configured, key: ticket.key, goal: ticket.title, dependsOn: ticket.blockedBy.map((ref) => byRef.get(ref)!),
      executions: configured.executions.map((job) => ({ ...job, instructions: `Issue：${ticket.ref}\n${ticket.body}\n\n本仓范围：${job.instructions}` })) };
  });
  return validateTaskGraphDefinition({ specRef, issueSource: source, nodes });
}

