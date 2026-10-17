import assert from 'node:assert/strict';
import { readIssueRoute, assertIssueSource, ticketMetadata } from '../src/lib/task-graph/issue-source';
import { parseIssueRef, type TrackerRequest } from '../src/lib/task-graph/issue-tracker';
import { buildIssueGraph, type IssueRouteSettings } from '../src/lib/task-graph/issue-route';

async function main() {
  const parent = 'gitee:org/app#IPARENT';
  const meta = (key: string, blockedBy: string[], owner: string | null = parent) => `<!-- ap-ticket-v1 ${JSON.stringify({ version: 1, project: 'fixture', sliceKey: key, parent: owner, blockedBy })} -->`;
  const root = { number: 'IPARENT', title: 'Spec', body: '# Frozen spec\n' + meta('SPEC', [], null), state: 'open' };
  const a = { number: 'IA', title: 'A', body: 'A criteria\n' + meta('A', []), state: 'open' };
  const b = { number: 'IB', title: 'B', body: 'B criteria\n' + meta('B', []), state: 'open' };
  const c = { number: 'IC', title: 'C', body: 'C criteria\n' + meta('C', ['gitee:org/app#IA', 'gitee:org/reader#IB']), state: 'open' };
  const calls: string[] = [];
  const request: TrackerRequest = async (provider, endpoint) => {
    calls.push(`${provider}:${endpoint}`);
    if (endpoint === '/repos/org/app/issues/IPARENT') return root;
    if (endpoint.startsWith('/repos/org/app/issues?')) return [root, a, c];
    if (endpoint.startsWith('/repos/org/reader/issues?')) return [b];
    throw new Error('Unexpected API call: ' + endpoint);
  };
  const route = await readIssueRoute(parent, ['gitee:org/reader'], request);
  assert.deepEqual(route.tickets.map((item) => [item.key, item.blockedBy]), [['A', []], ['B', []], ['C', ['gitee:org/app#IA', 'gitee:org/reader#IB']]]);
  const execution = { key: 'app', instructions: 'Scope only', repository: '/data1/code/fixture', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' };
  const slice = { executionMode: 'lean' as const, acceptance: { mode: 'automatic' as const, checks: ['smoke'] }, executions: [execution] };
  const settings: IssueRouteSettings = { parent, repositories: ['gitee:org/reader'], slices: { A: slice, B: slice, C: slice } };
  const graph = await buildIssueGraph('spec.md@fixed', settings, request);
  assert.deepEqual(graph.nodes[2].dependsOn, ['A', 'B']);
  assert.match(graph.nodes[1].executions[0].instructions, /B criteria/);
  assert.equal(parseIssueRef('gitee:org/reader#IB').id, 'IB');
  assert.throws(() => parseIssueRef('#12'), /full Issue/);
  assert.throws(() => parseIssueRef('github:org/app#ABC'), /full Issue/);
  await assert.rejects(() => readIssueRoute(parent, [], request), /outside imported/);
  c.body = 'changed criteria\n' + meta('C', ['gitee:org/app#IA', 'gitee:org/reader#IB']);
  await assert.rejects(() => assertIssueSource(route.source, request), /重新提审/);
  c.body = 'C criteria\n' + meta('C', ['gitee:org/app#IA', 'gitee:org/reader#IB']);
  a.state = 'closed';
  await assertIssueSource(route.source, request); // Closing an issue changes neither evidence nor execution dependencies.
  a.body = meta('A', ['gitee:org/app#IC']);
  await assert.rejects(() => readIssueRoute(parent, ['gitee:org/reader'], request), /cycle/);
  a.body = 'A criteria\n' + meta('A', []);
  b.body = meta('A', []);
  await assert.rejects(() => readIssueRoute(parent, ['gitee:org/reader'], request), /Duplicate/);
  b.body = 'B criteria\n' + meta('B', []);
  assert.throws(() => ticketMetadata(meta('A', ['#1'])), /full Issue/);
  assert.throws(() => ticketMetadata(meta('A', []) + meta('A', [])), /duplicate/);
  assert.throws(() => ticketMetadata(meta('A', ['gitee:org/app#IA', 'gitee:org/app#IA'])), /Duplicate/);
  await assert.rejects(() => readIssueRoute(parent, [], async () => { throw new Error('auth failed'); }), /auth failed/);
  const ghRoot = { number: 1, title: 'GH Spec', body: 'Spec', state: 'open' };
  const ghA = { number: 2, title: 'Native A', body: 'criteria', state: 'open', repository_url: 'https://api.github.com/repos/org/app' };
  const ghB = { ...ghA, number: 3, title: 'Native B', repository_url: 'https://api.github.com/repos/org/reader' };
  const github: TrackerRequest = async (_provider, endpoint) => {
    if (endpoint === '/repos/org/app/issues/1') return ghRoot;
    if (endpoint.startsWith('/repos/org/app/issues/1/sub_issues?')) return [ghA, ghB];
    if (endpoint.startsWith('/repos/org/app/issues/2/dependencies/blocked_by?')) return [];
    if (endpoint.startsWith('/repos/org/reader/issues/3/dependencies/blocked_by?')) return [ghA];
    throw new Error(endpoint);
  };
  const gh = await readIssueRoute('github:org/app#1', [], github);
  assert.deepEqual(gh.tickets[1].blockedBy, ['github:org/app#2']);
  assert.ok(calls.length > 0);
  console.log('Issue imports preserve Gitee IDs, use native GitHub edges and reject drift, cycles, missing references and duplicate metadata');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
