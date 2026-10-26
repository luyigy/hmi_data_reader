import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { effectiveArchitectureReview, taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from '../src/lib/task-graph/domain';
import { assertGraphCardBudget, buildGraphProposalCard, formatGraphProposal, graphRolesReady } from '../src/lib/task-graph/proposal-card';
import { configureGraphRoles, roomRoleCandidates, type RoleOption } from '../src/lib/task-graph/role-configuration';
import { assertSpecPackage, listSpecPackages, loadSpecPackage } from '../src/lib/task-graph/spec-package';
import { buildGraphSpecPicker } from '../src/lib/feishu-graph-picker';
import { graphFormAction, graphFormButtonName } from '../src/lib/task-graph/card-actions';
import { layoutGraph, graphSvg, renderGraphPng } from '../src/lib/task-graph/route-diagram';
import { taskGraphAgentReviewPermissionConfig } from '../src/lib/task-graph/review-permissions';
import { withCommandRoom } from '../src/lib/feishu-help';

async function main() {
  assert.deepEqual(taskGraphAgentReviewPermissionConfig, {
    profile: 'custom', sandboxMode: 'read-only', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [],
  });
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
  const prefilled = configureGraphRoles({ definition: graph, options, form: {}, suggest: true, humanId: 'human', preserveExplicitRoles: true });
  assert.equal(prefilled.nodes[0].architectureReview?.reviewerId, 'local:reviewer');
  assert.equal(prefilled.nodes[0].executions[0].agentSelector, 'local:implementer');
  assert.equal(prefilled.nodes[0].acceptance.mode, 'automatic');
  assert.deepEqual(configureGraphRoles({ definition: full, options, form: {}, suggest: true, humanId: 'human', preserveExplicitRoles: true }), full);
  // New proposals keep implementation self-tests; room recommendations are not acceptance consent.
  const owned: GraphDefinition = { ...structuredClone(graph), deliveryContract: 'agent_owned_v1' };
  const ownedBefore = taskGraphSnapshotHash(owned);
  const configureOwned = (definition = owned, form = {}, preserveExplicitRoles = true) =>
    configureGraphRoles({ definition, options, form, suggest: true, humanId: 'human', preserveExplicitRoles });
  const selfChecked = configureOwned();
  assert.equal(selfChecked.nodes[0].executionMode, 'lean');
  assert.equal(selfChecked.nodes[0].acceptance.mode, 'automatic');
  assert.equal(selfChecked.nodes[0].acceptance.reviewerId, undefined);
  assert.equal(selfChecked.defaultArchitectureReview, undefined);
  assert.equal(selfChecked.nodes[0].architectureReview, undefined);
  assert.equal(graphRolesReady(selfChecked), true);
  assert.equal(taskGraphSnapshotHash(owned), ownedBefore, 'Defaults must not mutate their input snapshot');
  assert.deepEqual(configureOwned(selfChecked, {}, false), selfChecked, 'Reset recommendations cannot appoint a Tester');
  const explicitTester = configureOwned(selfChecked, { acceptance_0: 'local:tester' });
  assert.equal(explicitTester.nodes[0].acceptance.reviewerId, 'local:tester');
  assert.deepEqual(configureOwned(explicitTester, {}, false).nodes[0].acceptance, explicitTester.nodes[0].acceptance);
  const explicitHuman = configureOwned(selfChecked, { acceptance_0: 'human' });
  assert.equal(configureOwned(explicitHuman, {}, false).nodes[0].acceptance.mode, 'human');
  const architecture = { reviewerId: 'local:reviewer', reviewLaunchConfig: { participant } };
  for (const definition of [
    { ...owned, defaultArchitectureReview: architecture },
    { ...owned, nodes: [{ ...owned.nodes[0], architectureReview: architecture }] },
    { ...owned, nodes: [{ ...owned.nodes[0], executionMode: 'full' as const }] },
  ]) assert.ok(effectiveArchitectureReview(configureOwned(definition), configureOwned(definition).nodes[0]), 'Explicit architecture remains effective');
  const adoption = { ...owned, adoptRun: { runId: 'old-run', snapshotHash: 'a'.repeat(64) } };
  assert.deepEqual(configureOwned(adoption), adoption, 'Association must preserve historical roles and modes');
  assert.match(formatGraphProposal(selfChecked), /精简：实施自测，无独立验收/);
  const selfCard = JSON.stringify(buildGraphProposalCard('p', selfChecked, 1, 'hash', options, 0));
  assert.match(selfCard, /实施自测，无独立验收/);
  assert.doesNotMatch(selfCard, /自动检查/);
  const ambiguous = structuredClone(selfChecked);
  ambiguous.nodes[0].executions.push({ ...ambiguous.nodes[0].executions[0], key: 'second' });
  assert.throws(() => validateTaskGraphDefinition(configureOwned(ambiguous)), /selfCheckExecution/);
  const lean = configureGraphRoles({ definition: full, options, form: { mode_0: 'lean' }, suggest: false, humanId: 'human' });
  assert.equal(effectiveArchitectureReview(lean, lean.nodes[0]), undefined);
  assert.equal(graphRolesReady(lean), true);
  assert.notEqual(taskGraphSnapshotHash(full), taskGraphSnapshotHash(lean));
  const implement = configureGraphRoles({ definition: lean, options, form: { mode_0: 'implement' }, suggest: false, humanId: 'human' });
  implement.nodes[0].acceptance.checks = [];
  validateTaskGraphDefinition(implement);
  assert.equal(graphRolesReady(implement), true);
  const hash = 'a'.repeat(64);
  const card = JSON.stringify(buildGraphProposalCard('p', implement, 1, hash, options));
  assert.match(card, /确认并启动/);
  assert.match(card, /未验收/);
  assert.match(card, /展开调整配置/);
  assert.doesNotMatch(card, /"tag":"form"|architecture_0|acceptance_0|column_set|"tag":"img"/);
  const editingImplement = JSON.stringify(buildGraphProposalCard('p', implement, 1, hash, options, 0));
  assert.match(editingImplement, /审查：此模式不启用/);
  assert.match(editingImplement, /验收：仅交付，未验收/);
  assert.doesNotMatch(editingImplement, /architecture_0|acceptance_0|column_set|"tag":"img"/);
  const longGraph = { ...full, nodes: Array.from({ length: 6 }, (_, index) => ({
    ...structuredClone(full.nodes[0]), key: `S${index + 1}`, dependsOn: index ? [`S${index}`] : [],
  })) };
  const compactCard = buildGraphProposalCard('p', longGraph, 3, hash, options);
  const compactJson = JSON.stringify(compactCard);
  const componentCount = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((count, item) => count + componentCount(item), 0);
    if (!value || typeof value !== 'object') return 0;
    const record = value as Record<string, unknown>;
    return Number(typeof record.tag === 'string') + Object.values(record).reduce<number>((count, item) => count + componentCount(item), 0);
  };
  assert.ok(componentCount(compactCard) <= 200);
  assert.match(compactJson, /\[S1 /);
  assert.match(compactJson, /\[S6 /);
  assert.match(compactJson, /"decision":"expand"/);
  assert.match(compactJson, /确认并启动/);
  assert.doesNotMatch(compactJson, /"tag":"form"|"tag":"img"|"tag":"column_set"|"tag":"collapsible_panel"|architecture_default/);
  for (let page = 0; page < 3; page++) {
    const pageCard = buildGraphProposalCard('proposal', longGraph, 3, hash, options, page);
    assertGraphCardBudget(pageCard);
    const json = JSON.stringify(pageCard);
    for (const field of ['job', 'architecture', 'acceptance']) assert.match(json, new RegExp(`${field}_${page * 2}`));
    assert.match(json, /模式：完整/);
    assert.match(json, /实施：implementer · codex/);
    assert.match(json, /保存并收起/);
    assert.match(json, /重置推荐分配/);
    assert.match(json, /"confirm"/);
    assert.doesNotMatch(json, /column_set|"tag":"img"|architecture_default/);
    const form = pageCard.body.elements.find((item) => 'elements' in item && item.tag === 'form');
    assert.ok(form && 'elements' in form);
    for (const item of (form.elements || []).filter((item) => item.tag === 'button')) {
      assert.ok(!('behaviors' in item), 'Native form submission must not have callback behaviors');
      assert.equal(graphFormAction('name' in item && typeof item.name === 'string' ? item.name : undefined)?.proposalId, 'proposal');
    }
  }
  assert.deepEqual(graphFormAction(graphFormButtonName('proposal', hash, 'page', 2)),
    { cmd: 'task-graph-launch', proposalId: 'proposal', hash, decision: 'page', page: 2 });
  assert.deepEqual(graphFormAction(graphFormButtonName('proposal', hash, 'configure', -1)),
    { cmd: 'task-graph-launch', proposalId: 'proposal', hash, decision: 'configure', page: -1 });
  const changedPage = configureGraphRoles({ definition: longGraph, options, form: { job_2_0: 'local:tester' }, suggest: false, humanId: 'human' });
  assert.equal(changedPage.nodes[2].executions[0].agentSelector, 'local:tester');
  assert.deepEqual(changedPage.nodes[0], longGraph.nodes[0]);
  const reset = configureGraphRoles({ definition: changedPage, options, form: {}, suggest: true, humanId: 'human' });
  assert.equal(reset.nodes[2].executions[0].agentSelector, 'local:implementer');
  assert.equal(reset.nodes[0].acceptance.reviewerId, 'local:tester');
  const branched = { ...longGraph, nodes: longGraph.nodes.slice(0, 4).map((node, i) => ({ ...node,
    goal: i === 0 ? '输入 <图像> 与数据' : node.goal, dependsOn: i === 0 ? [] : i === 3 ? ['S2', 'S3'] : ['S1'] })) };
  const roadmap = formatGraphProposal(branched);
  assert.match(roadmap, /┌ 并行阶段/);
  assert.match(roadmap, /├─ \[S2 /);
  assert.match(roadmap, /└─ \[S3 /);
  assert.match(roadmap, /\[S4 .*\] \(← S2, S3\)/);
  assert.match(roadmap, /审查:local:reviewer/);
  const readerExecution = { ...structuredClone(full.nodes[0].executions[0]), key: 'reader',
    repository: '/data1/code/reader', agentSelector: 'local:reviewer' };
  const multiRepo: GraphDefinition = { ...full, specPackage: { repository: '/data1/code/mold', commit: 'a'.repeat(40),
    manifestPath: 'docs/specs/hmi-screen-projection/spec-package.json', hash: 'a'.repeat(64) }, nodes: [{
    ...full.nodes[0], key: 'R02A', goal: 'Reader 提取能力',
    executions: [structuredClone(full.nodes[0].executions[0]), readerExecution],
  }] };
  const multiOverview = formatGraphProposal(multiRepo);
  assert.match(multiOverview, /Spec：hmi-screen-projection（完整目标、路径与验收细节见上方话题附件）/);
  assert.match(multiOverview, /\[R02A Reader 提取能力 \(reader\)\]/);
  assert.ok(multiOverview.includes('实施:main@mold:local:implementer、reader@reader:local:reviewer'));
  const multiCard = JSON.stringify(buildGraphProposalCard('proposal', multiRepo, 3, hash, options, 0));
  assert.match(multiCard, /实施\(main\)：/);
  assert.match(multiCard, /实施\(reader\)：/);
  const layout = layoutGraph(branched);
  assert.equal(layout.nodes.find((node) => node.key === 'S2')!.y, layout.nodes.find((node) => node.key === 'S3')!.y);
  assert.equal(layout.edges.length, 4);
  assert.match(graphSvg(branched), /&lt;图像&gt;/);
  assert.equal(Buffer.from(renderGraphPng(branched)).subarray(1, 4).toString(), 'PNG');

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
