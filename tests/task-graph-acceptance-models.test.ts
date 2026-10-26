import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assertAcceptanceModels, configureAcceptanceModels } from '../src/lib/task-graph/acceptance-models';
import { acceptanceCommands, validAcceptanceReceipt } from '../src/lib/task-graph/acceptance-evidence';
import { graphRoleOptions } from '../src/lib/task-graph/role-configuration';
import { formatGraphProposal } from '../src/lib/task-graph/proposal-card';
import { validateExecutionTargets } from '../src/lib/task-graph/launch';
import { taskGraphSnapshotHash, type GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  mkdirSync(path.join(process.cwd(), 'output'), { recursive: true });
  const root = mkdtempSync(path.join(process.cwd(), 'output/acceptance-models-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repository, 'value'), 'fixture'); git('add', '.'); git('commit', '-m', 'fixture');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', model: 'model-a' };
  const definition: GraphDefinition = { deliveryContract: 'agent_owned_v1', specRef: 'fixture', nodes: [{ key: 'A', goal: 'A', executionMode: 'lean', dependsOn: [],
    executions: [{ key: 'repo', instructions: 'A', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'different-name-a', launchConfig: { participant, checks: [{ name: 'test', argv: ['node', '-v'] }] } }],
    acceptance: { mode: 'agent', reviewerId: 'different-name-b', reviewLaunchConfig: { participant: { ...participant, role: 'tester' } }, checks: ['test'] },
  }] };
  const require = createRequire(__filename), catalog = require('../src/lib/codex-model-catalog');
  const original = catalog.loadCodexModelCatalog;
  const kimiCatalog = require('../src/lib/real-agents/kimi-code-model-catalog'), originalKimi = kimiCatalog.loadKimiCodeModelCatalog;
  kimiCatalog.loadKimiCodeModelCatalog = async () => ({ alias: {} });
  catalog.loadCodexModelCatalog = async () => ['model-a', 'model-b'].map(id => ({ id, efforts: [], defaultEffort: null }));
  const homes = { CODEX_HOME: process.env.CODEX_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
  process.env.CODEX_HOME = path.join(root, 'codex'); process.env.KIMI_CODE_HOME = path.join(root, 'kimi');
  mkdirSync(process.env.CODEX_HOME); mkdirSync(process.env.KIMI_CODE_HOME);
  try {
    await assert.rejects(() => validateExecutionTargets(structuredClone(definition)), /同模型/, 'Different names cannot impersonate different models');
    const members = require('../src/lib/live-room-members'), db = require('../src/lib/prisma').prisma;
    const list = members.listLiveRoomCatalogAgents, find = db.liveRoom.findFirst;
    members.listLiveRoomCatalogAgents = async () => [{ id: 'codex', backend: 'platform_local', gatewayId: 'platform-local', harnessType: 'codex', label: 'codex' }];
    db.liveRoom.findFirst = async () => ({ members: [{ joinStatus: 'joined', backend: 'platform_local', gatewayId: 'platform-local', harnessType: 'codex', role: 'tester', displayName: 'Tester', codexModel: 'model-b', codexReasoningEffort: 'high' }] });
    try {
      const [option] = await graphRoleOptions('fixture');
      assert.equal(option.participant.model, 'model-b'); assert.equal(option.participant.reasoningEffort, 'high');
    } finally { members.listLiveRoomCatalogAgents = list; db.liveRoom.findFirst = find; }
    const different = structuredClone(definition);
    (different.nodes[0].acceptance.reviewLaunchConfig as any).participant.model = 'model-b';
    const originalHash = taskGraphSnapshotHash(different);
    await validateExecutionTargets(different);
    assert.notEqual(taskGraphSnapshotHash(different), originalHash);
    assert.equal(different.nodes[0].acceptance.models?.reviewer.model, 'model-b');
    assert.match(formatGraphProposal(different), /其他模型独立验收:model-b/);
    const pinned = structuredClone(different);
    await validateExecutionTargets(different, 'verify');
    assert.deepEqual(different, pinned, 'Approval cannot rewrite a model binding');
    const unknown = structuredClone(definition);
    delete (unknown.nodes[0].acceptance.reviewLaunchConfig as any).participant.model;
    await assert.rejects(() => validateExecutionTargets(unknown), /模型未知/);
    (unknown.nodes[0].acceptance.reviewLaunchConfig as any).participant.model = 'unavailable';
    await assert.rejects(() => validateExecutionTargets(unknown), /模型不可用/);
    writeFileSync(path.join(process.env.CODEX_HOME!, 'config.toml'), 'model = "model-b"');
    delete (unknown.nodes[0].acceptance.reviewLaunchConfig as any).participant.model;
    await validateExecutionTargets(unknown);
    assert.equal((unknown.nodes[0].acceptance.reviewLaunchConfig as any).participant.model, 'model-b');
    writeFileSync(path.join(process.env.CODEX_HOME!, 'config.toml'), 'model = "model-a"');
    await assertAcceptanceModels(unknown.nodes[0]); // Explicit pin wins over a changed default.
    const kimiFile = path.join(process.env.KIMI_CODE_HOME!, 'config.toml');
    const kimiConfig = (model: string) => `default_model = "alias"\n[models.alias]\nmodel = "${model}"\nprovider = "fixture"\n[providers.fixture]\ntype = "openai_legacy"\nbase_url = "https://fixture.invalid"`;
    const alias = structuredClone(definition);
    (alias.nodes[0].acceptance.reviewLaunchConfig as any).participant = { ...participant, harnessType: 'kimi-code', model: 'alias', role: 'tester' };
    writeFileSync(kimiFile, kimiConfig('model-a'));
    await assert.rejects(() => validateExecutionTargets(alias), /同模型/, 'Different harnesses and aliases may use the same actual model');
    writeFileSync(kimiFile, kimiConfig('model-b'));
    kimiCatalog.loadKimiCodeModelCatalog = async () => ({});
    await assert.rejects(() => validateExecutionTargets(alias), /模型不可用/);
    kimiCatalog.loadKimiCodeModelCatalog = async () => ({ alias: {} });
    await validateExecutionTargets(alias);
    writeFileSync(kimiFile, kimiConfig('model-a'));
    await assert.rejects(() => validateExecutionTargets(alias, 'verify'), /同模型|已变化/);
    await assert.rejects(() => assertAcceptanceModels(alias.nodes[0]), /同模型|漂移/);
    const multiple = structuredClone(different);
    multiple.nodes[0].executions.push({ ...structuredClone(multiple.nodes[0].executions[0]), key: 'second' });
    (multiple.nodes[0].executions[1].launchConfig as any).participant.model = 'model-b';
    await assert.rejects(() => validateExecutionTargets(multiple), /同模型/, 'Reviewer must differ from every implementation model');
    const legacy = structuredClone(definition); delete legacy.deliveryContract;
    await validateExecutionTargets(legacy); assert.equal(legacy.nodes[0].acceptance.models, undefined);
    const adopted = { ...structuredClone(definition), adoptRun: { runId: 'old', snapshotHash: 'a'.repeat(64) } };
    await configureAcceptanceModels(adopted); assert.equal(adopted.nodes[0].acceptance.models, undefined);
    const inputs = [{ executionId: 'execution', commit: 'a'.repeat(40) }];
    const commits = [{ repository, commit: 'a'.repeat(40) }];
    const receipt = { inputs, commits, checks: acceptanceCommands(different.nodes[0]).map(command => ({ id: command.id, argv: command.argv, exitCode: 0, log: 'fixture.log: exited 0', environmentFingerprint: 'f'.repeat(64) })) };
    assert.ok(validAcceptanceReceipt(receipt, different.nodes[0], inputs, commits, true));
    for (const mutate of [
      (r: typeof receipt) => { r.checks = []; },
      (r: typeof receipt) => { r.inputs[0].commit = 'b'.repeat(40); },
      (r: typeof receipt) => { r.commits[0].commit = 'b'.repeat(40); },
      (r: typeof receipt) => { r.checks[0].argv = ['echo', 'fake']; },
      (r: typeof receipt) => { r.checks[0].exitCode = 1; },
      (r: typeof receipt) => { r.checks[0].log = ''; },
      (r: typeof receipt) => { r.checks[0].environmentFingerprint = ''; },
    ]) { const invalid = structuredClone(receipt); mutate(invalid); assert.equal(validAcceptanceReceipt(invalid, different.nodes[0], inputs, commits, true), false); }
    console.log('acceptance models: same/unknown/unavailable/default/alias/multi/drift/legacy; fixed receipt checks passed');
  } finally {
    catalog.loadCodexModelCatalog = original; kimiCatalog.loadKimiCodeModelCatalog = originalKimi;
    for (const [key, value] of Object.entries(homes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
