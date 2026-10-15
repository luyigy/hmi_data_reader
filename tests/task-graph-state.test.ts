import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { validateTaskGraphDefinition, type GraphDefinition } from '../src/lib/task-graph/domain';
import { claimNode, releaseReadyNodes } from '../src/lib/task-graph/store';

const sha = 'a'.repeat(40);
const job = (key: string) => ({ key, instructions: `Implement ${key}`, repository: '/data1/code/example', gitRef: 'main',
  baseCommit: sha, agentSelector: 'local:codex' });
const definition: GraphDefinition = { specRef: 'docs/spec.md@abc123', nodes: [
  { key: 'V1', goal: 'V1 works', dependsOn: [], acceptance: { mode: 'automatic', checks: ['smoke'] }, executions: [job('server')] },
  { key: 'V2', goal: 'V2 works', dependsOn: ['V1'], acceptance: { mode: 'agent', reviewerId: 'reviewer',
    reviewLaunchConfig: { participant: { gatewayId: 'local', harnessType: 'codex', role: 'reviewer', executionBackend: 'platform_local' } },
    checks: ['e2e'] }, executions: [job('ui')] },
  { key: 'V3', goal: 'V3 works', dependsOn: ['V2'], acceptance: { mode: 'human', reviewerId: 'human', checks: ['visual'] }, executions: [job('reader')] },
  { key: 'V5', goal: 'V5 works', dependsOn: ['V2'], acceptance: { mode: 'automatic', checks: ['smoke'] }, executions: [job('other')] },
] };

function fakeDb() {
  const nodes = definition.nodes.map((node, index) => ({ id: String(index), runId: 'run', key: node.key,
    dependsOn: node.dependsOn, status: 'planned', claimToken: null as string | null, claimedAt: null as Date | null }));
  const events: string[] = [];
  const tx = {
    taskGraphNode: {
      findMany: async () => nodes.map((node) => ({ ...node })),
      findUnique: async ({ where }: { where: { runId_key: { key: string } } }) =>
        nodes.find((node) => node.key === where.runId_key.key) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => nodes.find((node) => node.id === where.id)!,
      updateMany: async ({ where, data }: { where: { id: string; status: string; claimToken?: null }; data: { status: string; claimToken?: string; claimedAt?: Date } }) => {
        const node = nodes.find((item) => item.id === where.id && item.status === where.status &&
          (where.claimToken === undefined || item.claimToken === where.claimToken));
        if (!node) return { count: 0 };
        Object.assign(node, data);
        return { count: 1 };
      },
    },
    taskGraphExecution: { updateMany: async () => ({ count: 1 }) },
    taskGraphEvent: { create: async ({ data }: { data: { idempotencyKey: string } }) => { events.push(data.idempotencyKey); } },
  };
  return { nodes, events, db: { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient };
}

async function main() {
  assert.deepEqual(validateTaskGraphDefinition(definition).nodes.map((node) => node.key), ['V1', 'V2', 'V3', 'V5']);
  assert.throws(() => validateTaskGraphDefinition({ ...definition,
    nodes: definition.nodes.map((node) => node.key === 'V1' ? { ...node, dependsOn: ['V3'] } : node),
  }), /cycle/);
  assert.throws(() => validateTaskGraphDefinition({ ...definition,
    nodes: definition.nodes.map((node) => node.key === 'V2' ? { ...node, dependsOn: ['missing'] } : node),
  }), /dependencies/);
  assert.throws(() => validateTaskGraphDefinition({ ...definition,
    nodes: [{ ...definition.nodes[0], executions: [{ ...job('server'), repository: 'relative/repo' }] }],
  }), /repository execution/);

  const { nodes, events, db } = fakeDb();
  assert.deepEqual(await releaseReadyNodes('run', db), ['V1']);
  assert.deepEqual(await releaseReadyNodes('run', db), []);
  assert.equal((await claimNode('run', 'V1', 'token-a', db))?.status, 'claimed');
  assert.equal((await claimNode('run', 'V1', 'token-a', db))?.claimToken, 'token-a');
  assert.equal(await claimNode('run', 'V1', 'token-b', db), null);
  nodes[0].status = 'passed';
  assert.deepEqual(await releaseReadyNodes('run', db), ['V2']);
  assert.equal(nodes.find((node) => node.key === 'V3')?.status, 'planned');
  nodes[1].status = 'passed';
  assert.deepEqual(await releaseReadyNodes('run', db), ['V3', 'V5']);
  assert.equal(events.filter((key) => key === 'node:V1:ready').length, 1);
  console.log('Task graph validation, dependency frontier and claims passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
