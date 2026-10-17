import { createHash } from 'node:crypto';
import { issueEndpoint, issueRepository, parseIssueRef, readTrackerIssue, trackerIssue, trackerPages, trackerRequest, type TrackerRequest, type TrackerIssue } from './issue-tracker';

export type TicketMetadata = { version: 1; project: string; sliceKey: string; parent: string | null; blockedBy: string[] };
export type IssueSource = { parent: string; repositories: string[]; hash: string; tickets: { key: string; ref: string; hash: string }[] };
export type IssueTicket = TrackerIssue & { key: string; blockedBy: string[] };

export function ticketMetadata(body: string): TicketMetadata | null {
  const matches = Array.from(body.matchAll(/<!--\s*ap-ticket-v1\s+([\s\S]*?)\s*-->/g));
  if (!matches.length && !body.includes('ap-ticket-v1')) return null;
  if (matches.length !== 1) throw new Error('Missing or duplicate ap-ticket-v1 metadata');
  const value: unknown = JSON.parse(matches[0][1]);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('project' in value) || typeof value.project !== 'string' || !value.project
    || !('sliceKey' in value) || typeof value.sliceKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.sliceKey)
    || !('parent' in value) || (value.parent !== null && typeof value.parent !== 'string')
    || !('blockedBy' in value) || !Array.isArray(value.blockedBy) || value.blockedBy.some((ref) => typeof ref !== 'string')) throw new Error('Invalid ap-ticket-v1 metadata');
  if (value.parent) parseIssueRef(value.parent);
  const blockedBy: string[] = value.blockedBy;
  blockedBy.forEach(parseIssueRef);
  if (new Set(blockedBy).size !== blockedBy.length) throw new Error('Duplicate Issue blocker');
  return { version: 1, project: value.project, sliceKey: value.sliceKey, parent: value.parent, blockedBy };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ticketHash = (ticket: IssueTicket) => digest([ticket.ref, ticket.key, ticket.title, ticket.body, [...ticket.blockedBy].sort()]);

/** Issue relations are read from the tracker. Local execution settings contain no edges. */
export async function readIssueRoute(parentRef: string, repositories: string[] = [], request: TrackerRequest = trackerRequest) {
  const parent = await readTrackerIssue(parentRef, request);
  const parsed = parseIssueRef(parentRef);
  const metadata = ticketMetadata(parent.body);
  const repos = Array.from(new Set([issueRepository(parsed), ...repositories])).sort();
  repos.forEach((repo) => parseIssueRef(`${repo}#1`));
  if (repos.some((repo) => !repo.startsWith(parsed.provider + ':'))) throw new Error('One route must use one Issue provider');
  const tickets: IssueTicket[] = [];
  if (parsed.provider === 'gitee') {
    if (!metadata || metadata.parent !== null) throw new Error('Gitee parent requires versioned ticket metadata');
    for (const repo of repos) {
      const scope = parseIssueRef(`${repo}#1`);
      for (const raw of await trackerPages('gitee', `/repos/${scope.owner}/${scope.repo}/issues?state=all`, request)) {
        const item = trackerIssue(raw, repo);
        const meta = ticketMetadata(item.body);
        if (meta?.parent !== parentRef) continue;
        if (meta.project !== metadata.project) throw new Error(`Issue project mismatch: ${item.ref}`);
        tickets.push({ ...item, key: meta.sliceKey, blockedBy: [...meta.blockedBy].sort() });
      }
    }
  } else {
    for (const raw of await trackerPages('github', `${issueEndpoint(parsed)}/sub_issues`, request)) {
      if (!raw || typeof raw !== 'object' || !('repository_url' in raw) || typeof raw.repository_url !== 'string') throw new Error('GitHub sub-issue repository missing');
      const repo = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(raw.repository_url)?.[1];
      if (!repo) throw new Error('Invalid GitHub repository URL');
      const item = trackerIssue(raw, `github:${repo}`);
      const child = parseIssueRef(item.ref);
      const blockers = await trackerPages('github', `${issueEndpoint(child)}/dependencies/blocked_by`, request);
      const blockedBy = blockers.map((blocker) => {
        if (!blocker || typeof blocker !== 'object' || !('repository_url' in blocker) || typeof blocker.repository_url !== 'string') throw new Error('GitHub blocker repository missing');
        const repository = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(blocker.repository_url)?.[1];
        if (!repository) throw new Error('Invalid GitHub blocker repository');
        return trackerIssue(blocker, `github:${repository}`).ref;
      }).sort();
      tickets.push({ ...item, key: ticketMetadata(item.body)?.sliceKey || `GH_${child.owner}_${child.repo}_${child.id}`, blockedBy });
    }
  }
  if (!tickets.length || tickets.length > 100) throw new Error('Issue route needs 1–100 tickets');
  tickets.sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(tickets.map((item) => item.ref)).size !== tickets.length || new Set(tickets.map((item) => item.key)).size !== tickets.length) throw new Error('Duplicate Issue or Slice key');
  const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket]));
  const done = new Set<string>(); const visiting = new Set<string>();
  const visit = (ref: string) => {
    if (visiting.has(ref)) throw new Error(`Issue dependency cycle: ${ref}`);
    if (done.has(ref)) return;
    const ticket = byRef.get(ref);
    if (!ticket) throw new Error(`Issue blocker is outside imported route: ${ref}`);
    visiting.add(ref); ticket.blockedBy.forEach(visit); visiting.delete(ref); done.add(ref);
  };
  tickets.forEach((ticket) => visit(ticket.ref));
  const refs = tickets.map((item) => ({ key: item.key, ref: item.ref, hash: ticketHash(item) }));
  const source: IssueSource = { parent: parentRef, repositories: repos, hash: digest([parent.ref, parent.title, parent.body, refs]), tickets: refs };
  return { parent, tickets, source };
}

export async function assertIssueSource(source?: IssueSource, request = trackerRequest) {
  if (!source) return;
  const current = await readIssueRoute(source.parent, source.repositories, request);
  if (current.source.hash !== source.hash || current.source.tickets.length !== source.tickets.length || current.source.tickets.some((ticket, i) =>
    ticket.ref !== source.tickets[i].ref || ticket.key !== source.tickets[i].key || ticket.hash !== source.tickets[i].hash)) throw new Error('Issue 目标或依赖已变化，请重新提审');
  return current;
}
