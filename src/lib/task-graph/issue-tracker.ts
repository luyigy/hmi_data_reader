import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type IssueRef = { provider: 'github' | 'gitee'; owner: string; repo: string; id: string };
export type TrackerIssue = { ref: string; title: string; body: string; state: string };
export type TrackerRequest = (provider: IssueRef['provider'], endpoint: string, method?: string, body?: Record<string, unknown>) => Promise<unknown>;

export function parseIssueRef(value: string): IssueRef {
  const match = /^(github|gitee):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([A-Za-z0-9]+)$/.exec(value);
  if (!match || (match[1] === 'github' && !/^[1-9][0-9]*$/.test(match[4])) || match.slice(2, 4).some((part) => part === '.' || part === '..')) throw new Error(`Invalid full Issue reference: ${value}`);
  return { provider: match[1] === 'github' ? 'github' : 'gitee', owner: match[2], repo: match[3], id: match[4] };
}
export const issueRepository = (ref: IssueRef) => `${ref.provider}:${ref.owner}/${ref.repo}`;
export const issueEndpoint = (ref: IssueRef) => `/repos/${ref.owner}/${ref.repo}/issues/${ref.id}`;

/** Only platform CLI authentication is used. Model subprocesses never receive tracker credentials. */
export const trackerRequest: TrackerRequest = async (provider, endpoint, method = 'GET', body) => {
  const args = provider === 'gitee' ? ['api', endpoint, '--hostname', 'gitee.com', '--no-tui', '--method', method]
    : ['api', '--hostname', 'github.com', '--method', method, endpoint];
  if (body) args.push(...(provider === 'gitee' ? ['--body', JSON.stringify(body)] : ['--input', '-']));
  // gh stdin is needed for JSON bodies; use spawn rather than putting secrets in arguments.
  if (provider === 'github' && body) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.resume();
      child.on('error', (cause) => { clearTimeout(timer); reject(cause); });
      child.on('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`GitHub API ${method} ${endpoint.split('?')[0]} failed; check platform CLI authentication/network/permissions`)); else { try { resolve(output.trim() ? JSON.parse(output) : null); } catch (cause) { reject(cause); } } });
      child.stdin.end(JSON.stringify(body));
    });
  }
  try {
    const { stdout } = await execute(provider === 'gitee' ? 'gitee' : 'gh', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch { throw new Error(`${provider} API ${method} ${endpoint.split('?')[0]} failed; check platform CLI authentication/network/permissions`); }
};

export function trackerIssue(value: unknown, repository: string): TrackerIssue {
  if (!value || typeof value !== 'object' || !('number' in value) || !('title' in value) || typeof value.title !== 'string'
    || !('body' in value) || (value.body !== null && typeof value.body !== 'string') || !('state' in value) || typeof value.state !== 'string'
    || 'pull_request' in value) throw new Error('Invalid Issue API response');
  const ref = `${repository}#${value.number}`;
  parseIssueRef(ref);
  return { ref, title: value.title, body: value.body || '', state: value.state };
}

export async function trackerPages(provider: IssueRef['provider'], endpoint: string, request: TrackerRequest) {
  const result: unknown[] = [];
  for (let page = 1; page <= 20; page++) {
    const values = await request(provider, `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(values)) throw new Error('Invalid Issue list API response');
    result.push(...values);
    if (values.length < 100) return result;
  }
  throw new Error('Issue list exceeds import limit; narrow the configured repositories');
}

export async function readTrackerIssue(ref: string, request = trackerRequest) {
  const parsed = parseIssueRef(ref);
  const item = trackerIssue(await request(parsed.provider, issueEndpoint(parsed)), issueRepository(parsed));
  if (item.ref !== ref) throw new Error(`Issue API reference mismatch: ${ref}`);
  return item;
}
