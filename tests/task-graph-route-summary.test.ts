import assert from 'node:assert/strict';
import { formatGraphProposal, buildGraphProposalCard, assertGraphCardBudget } from '../src/lib/task-graph/proposal-card';
import type { GraphDefinition, GraphNode } from '../src/lib/task-graph/domain';

const node = (key: string, dependsOn: string[] = []): GraphNode => ({
  key, goal: key, dependsOn, executionMode: 'lean', acceptance: { mode: 'automatic', checks: [] },
  extraRepositories: [{ repository: '/fixture/other', access: 'read' }],
  executions: [{ key: 'job', instructions: key, repository: '/fixture/project', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }],
});
const graph: GraphDefinition = { specRef: 'test://route-summary', nodes: [
  node('R01'), node('M01', ['R01']), node('R02', ['R01']), node('R04', ['R01']),
  node('R05', ['R02', 'R04']), ...['A', 'B', 'C', 'D', 'E', 'F'].map(brand => node(`R6_${brand}`, ['R05'])),
  node('JOIN', ['R6_A', 'R6_B', 'R6_C', 'R6_D', 'R6_E', 'R6_F']),
] };
const before = JSON.stringify(graph);
const summary = formatGraphProposal(graph);
assert.match(summary, /启动：R01/);
assert.match(summary, /R01 通过后：M01、R02、R04 可并行/);
assert.match(summary, /R05 通过后：R6_A、R6_B、R6_C、R6_D、R6_E、R6_F 可并行/);
assert.match(summary, /每票只等待自身前置/);
assert.ok(summary.indexOf('R01 通过后') < summary.indexOf('附加仓库授权'), 'Parallel route must be visible before the permission list');
assert.match(summary, /JOIN.*← R6_A, R6_B, R6_C, R6_D, R6_E, R6_F/);
assert.equal(JSON.stringify(graph), before, 'Presentation cannot mutate the approved dependency snapshot');
assertGraphCardBudget(buildGraphProposalCard('fixture', graph, 1, 'a'.repeat(64)));
console.log('Route summary exposes serial prerequisites, parallel forks and joins before repository grants without changing the approved graph');
