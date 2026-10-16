import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { effectiveArchitectureReview, taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from '../src/lib/task-graph/domain';
import { buildGraphProposalCard, graphRolesReady } from '../src/lib/task-graph/proposal-card';
import { configureGraphRoles, roomRoleCandidates, type RoleOption } from '../src/lib/task-graph/role-configuration';
import { assertSpecPackage, listSpecPackages, loadSpecPackage } from '../src/lib/task-graph/spec-package';
import { buildGraphSpecPicker } from '../src/lib/feishu-graph-picker';
import { withCommandRoom } from '../src/lib/feishu-help';

async function main() {
  const participant = { gatewayId: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } as const;
  const options: RoleOption[] = ['implementer', 'reviewer', 'tester'].map((role) => ({ value: `local:${role}`, label: role, role, participant }));
  const graph: GraphDefinition = { specRef: 'spec.md@frozen', nodes: [{ key: 'S03', goal: 'Raw input projection', dependsOn: [],
    acceptance: { mode: 'automatic', checks: ['fixed'] }, executions: [{ key: 'main', instructions: 'Implement S03 only', repository: '/data1/code/mold',
      gitRef: 'refs/heads/dev', baseCommit: 'a'.repeat(40), agentSelector: 'local:implementer', launchConfig: { participant, checks: [{ name: 'fixed', argv: ['python', 'verify.py'] }] } }] }] };
  assert.equal(graphRolesReady(graph), false);
  const full = configureGraphRoles({ definition: graph, options, form: {}, suggest: true, humanId: 'human' });
  assert.equal(full.nodes[0].architectureReview?.reviewerId, 'local:reviewer');
  assert.equal(full.nodes[0].acceptance.reviewerId, 'local:tester');
  assert.equal(graphRolesReady(full), true);
  const lean = configureGraphRoles({ definition: full, options, form: { mode_0: 'lean' }, suggest: false, humanId: 'human' });
  assert.equal(effectiveArchitectureReview(lean, lean.nodes[0]), undefined);
  assert.equal(graphRolesReady(lean), true);
  assert.notEqual(taskGraphSnapshotHash(full), taskGraphSnapshotHash(lean));
  const implement = configureGraphRoles({ definition: lean, options, form: { mode_0: 'implement' }, suggest: false, humanId: 'human' });
  implement.nodes[0].acceptance.checks = [];
  validateTaskGraphDefinition(implement);
  assert.equal(graphRolesReady(implement), true);
  const card = JSON.stringify(buildGraphProposalCard('p', implement, 1, 'hash', options));
  assert.match(card, /确认并启动路线/);
  assert.match(card, /未验收/);
  assert.doesNotMatch(card, /architecture_0/);
  assert.doesNotMatch(card, /acceptance_0/);
  assert.throws(() => configureGraphRoles({ definition: graph, options, form: { job_0_0: 'remote:unregistered' }, suggest: false, humanId: 'human' }), /不可用/);
  const catalog = ['codex', 'pi-agent', 'kimi-code', 'claude'].map((harnessType) =>
    ({ backend: 'platform_local', gatewayId: 'platform-local', harnessType }));
  const joined = [{ joinStatus: 'joined', backend: 'platform_local', gatewayId: null,
    harnessType: 'codex', role: 'custom', displayName: 'codex' }];
  assert.deepEqual(roomRoleCandidates(catalog, joined).map((item) => item.harnessType), ['codex']);
  assert.equal(roomRoleCandidates(catalog, []).length, catalog.length);
  const menu = withCommandRoom({ nested: { behaviors: [{ type: 'callback', value: { cmd: 'ap-menu', view: 'workflow' } }] } }, 'parent-room');
  assert.match(JSON.stringify(menu), /"graphRoomId":"parent-room"/);

  const repository = await mkdtemp(path.join(os.tmpdir(), 'task-graph-spec-'));
  try {
    const git = (...argv: string[]) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Workflow test'); git('config', 'user.email', 'workflow@example.test');
    const directory = path.join(repository, 'docs/specs/pilot');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'spec-package.json'), JSON.stringify({ title: 'HMI pilot', status: 'ready', spec: 'spec.md', route: 'route.json', artifacts: ['route.html'] }));
    await writeFile(path.join(directory, 'spec.md'), '# Spec\nFrozen input');
    await writeFile(path.join(directory, 'route.json'), JSON.stringify(graph));
    await writeFile(path.join(directory, 'route.html'), '<!doctype html><title>Route</title>');
    git('add', '.'); git('commit', '-m', 'Add test Spec');
    const first = await listSpecPackages(repository);
    assert.equal(first.packages.length, 1);
    const item = first.packages[0];
    assert.equal(item.artifacts.length, 2);
    await assertSpecPackage(item);
    await assert.rejects(() => assertSpecPackage({ ...item, hash: '0'.repeat(64) }), /哈希/);
    await assert.rejects(() => loadSpecPackage(repository, first.commit, 'docs/specs/../spec-package.json'), /引用无效/);
    await writeFile(path.join(directory, 'spec.md'), '# Changed but uncommitted');
    assert.equal((await listSpecPackages(repository)).packages[0].hash, item.hash);
    git('add', '.'); git('commit', '-m', 'Change Spec');
    assert.notEqual((await listSpecPackages(repository)).packages[0].hash, item.hash);
    assert.equal((await assertSpecPackage(item))?.hash, item.hash);
    const picker = JSON.stringify(buildGraphSpecPicker({ roomId: 'parent', commit: first.commit, packages: first.packages }));
    assert.match(picker, /selectedSpec/);
    assert.match(picker, /发送路线提审/);
    assert.match(picker, /parent/);
  } finally { await rm(repository, { recursive: true, force: true }); }
  console.log('Task graph modes, role matrix, parent context and immutable Spec packages passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
