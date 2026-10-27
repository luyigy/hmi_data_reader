import { ensureJobWorktree, ensureIntegrationRef } from '../src/lib/task-graph/worktree';
import { configureAcceptanceModels } from '../src/lib/task-graph/acceptance-models';
import { admitNode } from '../src/lib/task-graph/preparation-recovery';
import { recoverPendingReviewRepairs } from '../src/lib/task-graph/pending-review-repair';
import { acceptanceCommands } from '../src/lib/task-graph/acceptance-evidence';
import { createHash } from 'node:crypto';
import { setGraphRunPaused } from '../src/lib/task-graph/run-control';
import { buildGraphOverview, loadGraphOverview } from '../src/lib/task-graph/overview';
import { buildGraphNodeCard } from '../src/lib/task-graph/node-card';
import { executionProgress, initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { createTaskGraphRun, approveHumanNode, releaseReadyNodes, submitNodeVerification, completeUnverifiedNode } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { validateTaskGraphDefinition, taskGraphSnapshotHash, type GraphDefinition } from '../src/lib/task-graph/domain';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'agent-owned-quality-session-'));

async function scenario(mode: 'self-environment' | 'self-human' | 'environment-blocked' | 'review-environment' | 'review-human' | 'architecture-environment' | 'blocked' | 'failed' | 'needs-human' | 'default' | 'self' | 'plain-delivery' | 'history' | 'cross' | 'self-defect' | 'multi' | 'conflict' | 'tester' | 'tester-auth' | 'architecture-auth' | 'tester-missing' | 'tester-sha' | 'tester-dirty' | 'tester-model-drift' | 'human' | 'repair' | 'implement' | 'format' | 'full' | 'self-repair' | 'architecture') {
  const businessStop = ['self-environment', 'self-human', 'environment-blocked', 'review-environment', 'review-human', 'architecture-environment', 'blocked', 'failed', 'needs-human', 'repair', 'architecture', 'self-defect'].includes(mode);
  const rejectedReview = ['tester-missing', 'tester-sha', 'tester-dirty', 'tester-model-drift'].includes(mode);
  const explicitReview = mode === 'review-environment' || mode === 'review-human' || mode === 'tester' || mode === 'tester-auth' || mode === 'repair' || rejectedReview;
  const multiple = mode === 'multi' || mode === 'conflict' || mode === 'cross';
  let allowBusinessResume = false;
  let conflictResolutions = 0, jointRuns = 0;
  const root = mkdtempSync(path.join(fixtureRoot, 'case-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repository, 'value'), 'base'); if (mode === 'conflict') writeFileSync(path.join(repository, 'shared'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer', model: 'fixture-codex' };
  const tester = { ...participant, harnessType: 'kimi-code', role: 'tester', model: 'fixture-kimi' };
  const command = [process.execPath, '-e', 'if(require("node:fs").readFileSync("value","utf8")!=="good")throw Error("behavior missing")'];
  const definition: GraphDefinition = { deliveryContract: 'agent_owned_v1', specRef: 'fixture://quality', nodes: [{
    key: 'A', goal: 'required behavior', dependsOn: [], executionMode: mode === 'implement' ? 'implement' : mode === 'full' || mode === 'architecture' || mode === 'architecture-auth' || mode === 'architecture-environment' ? 'full' : 'lean',
    ...((mode === 'full' || mode === 'architecture' || mode === 'architecture-auth' || mode === 'architecture-environment') ? { architectureReview: { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: { ...tester, role: 'reviewer' } } } } : {}),
    acceptance: { mode: explicitReview ? 'agent' : mode === 'human' ? 'human' : 'automatic',
      ...(explicitReview ? { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: tester } } : mode === 'human' ? { reviewerId: 'fixture-human' } : {}),
      checks: ['behavior'], integrationChecks: [{ name: 'joint', repository, argv: command }] },
    executions: [{ key: 'repo', instructions: 'implement behavior', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', launchConfig: { participant, checks: [{ name: 'behavior', argv: command }] } }],
  }] };
  if (multiple) definition.nodes[0].executions.push({ ...structuredClone(definition.nodes[0].executions[0]), key: 'other', agentSelector: 'local:kimi-code', launchConfig: { participant: { ...tester, role: 'implementer' }, checks: [{ name: 'behavior', argv: command }] } });
  if (multiple) {
    assert.throws(() => validateTaskGraphDefinition(definition), /selfCheckExecution/, 'Multiple implementors cannot silently assign the first');
    definition.nodes[0].acceptance.selfCheckExecution = 'other';
    const changed = structuredClone(definition); changed.nodes[0].acceptance.selfCheckExecution = 'repo';
    assert.notEqual(taskGraphSnapshotHash(changed), taskGraphSnapshotHash(definition), 'Owner is part of the approval snapshot');
  }
  definition.nodes.push({ ...structuredClone(definition.nodes[0]), key: 'B', dependsOn: ['A'], acceptance: { mode: 'automatic', checks: ['behavior'], ...(multiple ? { selfCheckExecution: 'other' } : {}) } });
  if (mode === 'cross') {
    const second = path.join(root, 'second'); mkdirSync(second);
    const otherGit = (...args: string[]) => execFileSync('git', args, { cwd: second, encoding: 'utf8', stdio: 'pipe' }).trim();
    otherGit('init', '-b', 'main'); otherGit('config', 'user.name', 'Fixture'); otherGit('config', 'user.email', 'fixture@example.test');
    writeFileSync(path.join(second, 'value'), 'base'); otherGit('add', '.'); otherGit('commit', '-m', 'base');
    for (const slice of definition.nodes) {
      slice.executions[1].repository = second; slice.executions[1].baseCommit = otherGit('rev-parse', 'HEAD');
      slice.acceptance.selfCheckExecution = 'repo';
      slice.acceptance.integrationChecks = [{ name: 'joint', repository, argv: [process.execPath, '-e',
        'const fs=require("fs"),p=require("path"),ms=JSON.parse(process.env.TASK_GRAPH_UPSTREAM_INPUTS_JSON); const input=ms.flatMap(m=>m.inputs).find(i=>i.repository!==process.env.AP_PROJECT_REPOSITORY); if(!input||fs.readFileSync(p.join(input.sourcePath,"value"),"utf8")!=="good"||fs.readFileSync("value","utf8")!=="good")throw Error("joint input missing");'] }];
    }
  }
  const priorHomes = { CODEX_HOME: process.env.CODEX_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
  process.env.CODEX_HOME = path.join(root, 'codex'); process.env.KIMI_CODE_HOME = path.join(root, 'kimi');
  mkdirSync(process.env.CODEX_HOME); mkdirSync(process.env.KIMI_CODE_HOME);
  writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "fixture-codex"');
  writeFileSync(path.join(process.env.KIMI_CODE_HOME, 'config.toml'), 'default_model = "fixture-kimi"\n[models.fixture-kimi]\nmodel = "kimi-other"\nprovider = "fixture"\n[providers.fixture]\ntype = "kimi"');
  await configureAcceptanceModels(definition);
  const parent = await prisma.task.create({ data: { name: 'agent-owned fixture' } });
  let run;
  if (mode === 'default' || mode === 'tester') {
    const previousRoots = process.env.SCHEDULED_JOB_WORKSPACE_ROOTS;
    process.env.SCHEDULED_JOB_WORKSPACE_ROOTS = fixtureRoot;
    delete definition.deliveryContract;
    definition.nodes.forEach(slice => { delete slice.executionMode; });
    const require = createRequire(__filename);
    const roles = require('../src/lib/task-graph/role-configuration');
    const api = require('../src/lib/feishu-api');
    const auth = require('../src/lib/feishu-access-approval');
    const previous = { options: roles.graphRoleOptions, send: api.sendFeishuInteractiveMessage, admin: auth.isFeishuAdmin };
    roles.graphRoleOptions = async () => [{ value: 'local:kimi-code', label: 'Room tester', role: 'tester', participant: tester }];
    api.sendFeishuInteractiveMessage = async () => 'fixture-proposal-card';
    auth.isFeishuAdmin = (id: string) => id === 'fixture-human';
    const room = await prisma.liveRoom.create({ data: { title: 'Default self-test proposal', sourceTaskId: parent.id } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: parent.id, chatId: parent.id,
      chatType: 'p2p', appId: 'fixture', liveRoomId: room.id } });
    try {
      const { createGraphProposal, handleGraphProposalCardAction } = await import('../src/lib/task-graph/proposals');
      const proposal = await createGraphProposal({ parentTaskId: parent.id, definition, createdBy: 'fixture' });
      const approved = proposal.definition as unknown as GraphDefinition;
      assert.equal(approved.deliveryContract, 'agent_owned_v1');
      assert.ok(approved.nodes.every(slice => slice.executionMode === 'lean'));
      if (mode === 'default') assert.ok(approved.nodes.every(slice => slice.acceptance.mode === 'automatic' && !slice.acceptance.reviewerId));
      else assert.equal(approved.nodes[0].acceptance.models?.reviewer.model, 'kimi-other');
      assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
      const action = { proposalId: proposal.id, decision: 'approve', hash: proposal.snapshotHash,
        openId: 'fixture-human', chatId: parent.id, messageId: proposal.cardMessageId };
      assert.equal((await handleGraphProposalCardAction({ ...action, openId: 'intruder' })).toast.type, 'warning');
      assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
      if (mode === 'tester') {
        const configFile = path.join(process.env.KIMI_CODE_HOME!, 'config.toml');
        const config = readFileSync(configFile, 'utf8');
        writeFileSync(configFile, config.replace('kimi-other', 'fixture-codex'));
        await assert.rejects(() => handleGraphProposalCardAction(action), /同模型|已变化/);
        assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
        assert.equal((await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status, 'pending');
        writeFileSync(configFile, config);
      }
      assert.equal((await handleGraphProposalCardAction(action)).toast.type, 'success');
      await handleGraphProposalCardAction(action);
      assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 1);
      run = await prisma.taskGraphRun.findFirstOrThrow({ where: { parentTaskId: parent.id } });
      assert.equal(run.snapshotHash, proposal.snapshotHash);
      assert.deepEqual(run.snapshot, proposal.definition);
    } finally {
      roles.graphRoleOptions = previous.options; api.sendFeishuInteractiveMessage = previous.send; auth.isFeishuAdmin = previous.admin;
      if (previousRoots === undefined) delete process.env.SCHEDULED_JOB_WORKSPACE_ROOTS;
      else process.env.SCHEDULED_JOB_WORKSPACE_ROOTS = previousRoots;
    }
  } else run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } }, include: { executions: true } });
  if (mode === 'history') await prisma.taskGraphExecution.update({ where: { id: node.executions[0].id }, data: { dispatchMetadata: { progress: { ...initialExecutionProgress(), repairAttempts: 2 } } } });
  const adapter = getHarnessAdapter('codex')!, independent = getHarnessAdapter('kimi-code')!;
  const original = { execute: adapter.execute, resume: adapter.resume, tester: independent.execute, testerResume: independent.resume };
  if (mode === 'conflict') {
    // Pin both candidates before either writer runs, so the fixture creates a real divergent merge.
    for (const job of node.executions) {
      const integration = await ensureIntegrationRef({ repoPath: job.repository, runId: run.id, baseRef: job.gitRef, baseCommit: job.baseCommit });
      const workspace = await ensureJobWorktree({ repoPath: job.repository, runId: run.id, jobId: job.id, baseRef: job.gitRef, baseCommit: job.baseCommit });
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { worktreePath: workspace.path, worktreeBranch: workspace.branch,
        dispatchMetadata: { integrationRef: integration.ref, workspaceBase: job.baseCommit, progress: { ...initialExecutionProgress(), workspaceBase: job.baseCommit, candidateCommit: job.baseCommit } } } });
    }
  }
  let starts = 0, successorStarts = 0, reviews = 0, testerReviews = 0, commands = 0;
  const reviewedCommits: string[] = [];
  let architectureStarts = 0;
  let originalDelivery: unknown;
  const rememberDelivery = async () => {
    assert.equal(successorStarts, 0, 'An unfinished review must not launch the successor');
    const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id }, orderBy: { id: 'asc' } });
    const delivery = jobs.map(job => ({ id: job.id, commit: job.commit, evidence: job.evidence, taskRunId: job.taskRunId }));
    if (originalDelivery) assert.deepEqual(delivery, originalDelivery, 'Review recovery preserves implementation evidence and candidate');
    else originalDelivery = delivery;
  };
  const codingTurns = new Map<string, number>();
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const { task, context } = args;
    const prompt = 'continuationMessage' in args ? args.continuationMessage : task.description || '';
    if (task.id.startsWith('task-graph-architecture-')) {
      if (task.name.startsWith('A')) {
        architectureStarts++;
        if (mode === 'architecture-auth') {
          await rememberDelivery();
          if (architectureStarts === 1) return { success: false, error: 'HTTP 401 Unauthorized: fixture login unavailable', output: 'HTTP 401 Unauthorized: fixture login unavailable', executionTime: 1 };
        }
      }
      if (mode === 'architecture-environment') return { success: true, output: 'TASK_GRAPH_ARCH_REVIEW {"approved":false,"note":"Required architecture inspection tool unavailable","failureKind":"environment_failed"}', executionTime: 1 };
      const failed = mode === 'architecture' && task.name.startsWith('A') && starts === 1;
      const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      return { success: true, output: 'TASK_GRAPH_ARCH_REVIEW ' + JSON.stringify({ approved: !failed, note: 'approved architecture scope verified', ...(failed ? { failureKind: 'in_scope_defect', failureKey: 'architecture:scope', executionIds: jobs.map(job => job.id) } : {}) }), executionTime: 1 };
    }
    if (task.id.startsWith('task-graph-review-')) {
      assert.ok(explicitReview, 'Self-check and Human modes must not start a Review TaskRun');
      const a = task.name.startsWith('A'); if (a) reviews++;
      if (explicitReview && a) testerReviews++;
      const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId: run.id, key: a ? 'A' : 'B' } } });
      const checks = JSON.parse(prompt.match(/稳定检查 ID 和可回修执行：(\[[^\n]+\])。/)![1]);
      const workspaces = JSON.parse(prompt.match(/仓库检出目录: (\[[^\n]+\])\n证据:/)![1]);
      const workspace = workspaces[workspaces.length - 1];
      assert.match(prompt, /批准的仓内检查/);
      assert.ok(prompt.includes(JSON.stringify(command)), 'The exact approved argv is delivered to the quality owner');
      if (a) reviewedCommits.push(workspace.commit);
      assert.equal(context.model, 'fixture-kimi', 'Approved model reaches the harness');
      if (mode === 'tester-auth') {
        await rememberDelivery();
        if (reviews === 1) return { success: false, error: 'HTTP 401 Unauthorized: fixture login unavailable', output: 'HTTP 401 Unauthorized: fixture login unavailable', executionTime: 1 };
      }
      if (mode === 'review-environment' || mode === 'review-human') return { success: true, output: 'TASK_GRAPH_REVIEW ' + JSON.stringify({ approved: false, note: 'Required review input is unavailable', failureKind: mode === 'review-human' ? 'blocked_require_human' : 'environment_failed' }), executionTime: 1 };
      const receiptChecks = acceptanceCommands(definition.nodes[0]).map(check => {
        let exitCode = 0, log = '';
        try { commands++; log = execFileSync(check.argv[0], check.argv.slice(1), { cwd: workspace.path, encoding: 'utf8', stdio: 'pipe' }); }
        catch (error) { exitCode = Number((error as any).status) || 1; log = String((error as any).stderr || 'failed'); }
        return { id: check.id, argv: check.argv, exitCode, log: `actual fixture command exit=${exitCode}: ${log}`, environmentFingerprint: createHash('sha256').update(JSON.stringify({ node: process.version, platform: process.platform })).digest('hex') };
      });
      const passed = receiptChecks.every(check => check.exitCode === 0);
      const verification = { inputs: jobs.map(job => ({ executionId: job.id, commit: job.commit })), commits: [{ repository, commit: workspace.commit }], checks: receiptChecks };
      assert.ok(!checks.some((check: { id: string }) => check.id === 'architecture:scope'), 'Acceptance must not require architecture evidence again');
      const decision = { approved: passed, verification, note: `fixed behavior ${passed}`,
        ...(!passed ? { failureKind: 'in_scope_defect', failureKey: 'acceptance:behavior', executionIds: jobs.map(job => job.id) } : {}) };
      if (mode === 'tester-missing') delete (decision as any).verification;
      if (mode === 'tester-sha') decision.verification.commits[0].commit = 'c'.repeat(40);
      if (mode === 'tester-dirty') writeFileSync(path.join(workspace.path, 'pollution'), 'must block');
      return { success: true, output: `TASK_GRAPH_REVIEW ${JSON.stringify(decision)}`, executionTime: 1 };
    }
    const a = task.name.startsWith('A'); if (a) starts++; else successorStarts++;
    const executionKey = task.name.split(' · ')[1];
    const codingKey = `${a ? 'A' : 'B'}-${executionKey}`;
    if (mode === 'conflict' && prompt.includes('受控冲突修复')) {
      conflictResolutions++;
      assert.equal(successorStarts, 0);
      writeFileSync(path.join(context.taskEnvironment!.AP_GRAPH_OUTPUT_DIR!, 'resolution.json'), JSON.stringify({ files: [{ path: 'shared', content: 'repo\nother\n' }] }));
      return { success: true, sessionId: `original-${codingKey}`, sessionKind: executionKey === 'other' ? 'kimi_session' : 'codex_thread', output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"resolved both changes","evidence":["resolution.json"]}', executionTime: 1 };
    }
    const turns = (codingTurns.get(codingKey) || 0) + 1; codingTurns.set(codingKey, turns);
    const native = multiple ? `original-${codingKey}` : a ? 'original-A' : 'original-B';
    const sessionKind = multiple && executionKey === 'other' ? 'kimi_session' : 'codex_thread';
    if (a && !allowBusinessResume && ['environment-blocked', 'blocked', 'failed', 'needs-human'].includes(mode)) return { success: true, sessionId: native, sessionKind,
      output: 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify({ status: mode === 'failed' ? 'failed' : 'blocked',
        note: 'Cannot finish the approved behavior', ...(mode === 'failed' ? {} : { blockerKind: mode === 'needs-human' ? 'permission_required' : mode === 'environment-blocked' ? 'environment_failed' : 'missing_upstream_input' }) }), executionTime: 1 };
    if (turns > 1) assert.equal('sessionId' in args ? args.sessionId : null, native, 'repair resumes the responsible implementor Session');
    if (mode === 'conflict' && a && turns === 1) writeFileSync(path.join(context.workingDirectory, 'shared'), `${executionKey}\n`);
    if (multiple) writeFileSync(path.join(context.workingDirectory, `${executionKey}.txt`), executionKey);
    writeFileSync(path.join(context.workingDirectory!, 'value'), a && ['repair', 'format', 'self-repair', 'self-defect', 'architecture'].includes(mode) && starts === 1 ? 'bad' : 'good');
    if (a && mode === 'format' && starts === 1) return { success: true, sessionId: 'original-A', sessionKind: 'codex_thread', output: 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","note":"missing blockerKind"}', executionTime: 1 };
    if (mode === 'plain-delivery' && a && turns > 1) assert.equal(successorStarts, 0, 'Plain delivery must not release successors before formal self-check');
    if (mode !== 'implement' && !(a && (mode === 'repair' || mode === 'architecture' || mode === 'self-defect') && starts === 1)) {
      let passed = true;
      try { execFileSync(command[0], command.slice(1), { cwd: context.workingDirectory, stdio: 'pipe' }); } catch { passed = false; }
      if (!passed) return { success: true, sessionId: native, sessionKind, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"working","note":"self-check failed; fixing in the same Coding Session"}', executionTime: 1 };
    }
    if (mode === 'tester-model-drift' && a) {
      const configFile = path.join(process.env.KIMI_CODE_HOME!, 'config.toml');
      writeFileSync(configFile, readFileSync(configFile, 'utf8').replace('kimi-other', 'fixture-codex'));
    }
    if (multiple) writeFileSync(path.join(context.workingDirectory, `${executionKey}-report.json`), JSON.stringify({ time: Date.now(), turns }));
    const ownsQuality = !multiple || executionKey === (mode === 'cross' ? 'repo' : 'other');
    const manifests = JSON.parse(context.taskEnvironment?.TASK_GRAPH_UPSTREAM_INPUTS_JSON || '[]');
    const ticketReady = manifests.some((m: { ticketInputs?: unknown }) => Array.isArray(m.ticketInputs));
    if (mode === 'cross' && ownsQuality && ticketReady) {
      execFileSync(definition.nodes[0].acceptance.integrationChecks![0].argv[0], definition.nodes[0].acceptance.integrationChecks![0].argv.slice(1), { cwd: context.workingDirectory, env: { ...process.env, ...context.taskEnvironment }, stdio: 'pipe' }); jointRuns++;
    }
    const formal = mode !== 'implement' && ownsQuality && !(['plain-delivery', 'history'].includes(mode) && a && turns === 1) && (mode !== 'cross' || ticketReady)
      ? { ticketVerification: { approved: !(mode === 'self-defect' && a && turns === 1) && !['self-environment', 'self-human'].includes(mode), ...(['self-environment', 'self-human'].includes(mode) ? { failureKind: mode === 'self-human' ? 'blocked_require_human' : 'environment_failed' } : {}), ...(mode === 'self-defect' && a && turns === 1 ? { failureKind: 'in_scope_defect', failureKey: 'acceptance:behavior', executionIds: node.executions.map(job => job.id) } : {}), note: 'Ran the approved behavior and joint commands on the supplied input combination; value=good' } } : {};
    return { success: true, sessionId: native, sessionKind, output: 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify({ status: 'delivered', note: 'implemented', evidence: ['value'], ...formal }), executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute; independent.execute = execute; independent.resume = execute;
  const drain = async () => { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); };
  try {
    if (mode === 'default') {
      await setGraphRunPaused({ runId: run.id, paused: true, requestId: 'pause-default', reason: 'pause boundary', actorId: 'fixture-human' });
      await runTaskGraphCycle();
      assert.equal(starts + successorStarts, 0, 'Paused approval cannot start a Writer');
      await setGraphRunPaused({ runId: run.id, paused: false, requestId: 'resume-default', reason: 'resume approved route', actorId: 'fixture-human' });
    }
    for (let i = 0; i < 400; i++) {
      await runTaskGraphCycle();
      const current = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
      if ((rejectedReview || businessStop) && current.status === 'attention') break;
      if (mode === 'human' && current.status === 'awaiting_human') {
        assert.equal(successorStarts, 0);
        const evidence = current.evidence;
        assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
        await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: 'intruder', evidence: JSON.parse(JSON.stringify(evidence)) }), /responsib|review|identity|actor/i);
        await assert.rejects(() => approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'intruder', approved: true, note: 'no' }), /Wrong human/);
        const pinned = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
        await prisma.taskGraphExecution.update({ where: { id: pinned.id }, data: { commit: 'c'.repeat(40) } });
        await assert.rejects(() => approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'fixture-human', approved: true, note: 'stale approval' }), /input commits/);
        await prisma.taskGraphExecution.update({ where: { id: pinned.id }, data: { commit: pinned.commit } });
        const writers = createRequire(__filename)('../src/lib/task-graph/writer-ownership');
        const observe = writers.observeTaskRunWriter;
        writers.observeTaskRunWriter = async (id: string) => { if (id === pinned.taskRunId) throw new Error('Human approval must not repeat Agent runtime inspection'); return observe(id); };
        try { await approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'fixture-human', approved: true, note: 'approved fixed evidence' }); }
        finally { writers.observeTaskRunWriter = observe; }
        await releaseReadyNodes(run.id);
      }
      if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === (mode === 'implement' ? 'completed_unverified' : 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await drain();
    const after = await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } });
    if (businessStop) {
      assert.equal(after.status, 'attention'); assert.equal(starts, 1); assert.equal(successorStarts, 0);
      const saved = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
      const progress = executionProgress(saved.dispatchMetadata)!;
      assert.equal(progress.businessResult, ['self-environment', 'self-human', 'environment-blocked', 'review-environment', 'review-human', 'architecture-environment', 'blocked', 'needs-human'].includes(mode) ? 'blocked' : 'failed');
      assert.equal(progress.lastFailure?.requiresUserDecision, mode === 'needs-human' || mode === 'review-human' || mode === 'self-human');
      assert.equal(progress.repairAttempts, 0, 'Business classification must not spend repair budgets or requeue');
      for (let i = 0; i < 3; i++) {
        await recoverPendingReviewRepairs(run.id);
        const wake = await admitNode(node.id, { source: 'conditions', id: `changed-conditions-${i}`, version: String(i) });
        assert.equal('reason' in wake && wake.reason, 'business_result_stopped');
        await runTaskGraphCycle();
      }
      await drain();
      assert.equal(starts, 1); assert.equal(successorStarts, 0);
      assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 0);
      assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: saved.id } })).commit, saved.commit);
      assert.match(JSON.stringify(buildGraphNodeCard({ ...after, executions: [saved] })), /失败|阻塞/);
      if (mode === 'architecture-environment') {
        assert.equal((after.evidence as any).checks.find((check: any) => check.name === 'behavior').passed, true);
        assert.match((after.evidence as any).summary, /未完成/);
      }
      if (mode === 'review-environment' || mode === 'review-human') assert.equal(reviews, 1, 'A blocked report does not require fabricated successful check receipts');
      if (mode === 'blocked' || mode === 'failed') {
        allowBusinessResume = true;
        await setGraphRunPaused({ runId: run.id, paused: true, requestId: 'pause-stopped', reason: 'pause', actorId: 'fixture-human' });
        const paused = await admitNode(node.id, { source: 'operator', id: 'explicit-restart' });
        assert.equal('reason' in paused && paused.reason, 'run_paused_or_complete');
        await setGraphRunPaused({ runId: run.id, paused: false, requestId: 'unpause-stopped', reason: 'resume', actorId: 'fixture-human' });
        assert.equal((await admitNode(node.id, { source: 'operator', id: 'explicit-restart' })).kind, 'admitted');
        assert.equal((await admitNode(node.id, { source: 'operator', id: 'explicit-restart' })).kind, 'already_scheduled');
        for (let i = 0; i < 100; i++) {
          await runTaskGraphCycle(); await drain();
          if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed') break;
        }
        assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status, 'passed');
        assert.equal(starts, 2); assert.equal(successorStarts, 1);
        const resumed = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: saved.id } })).dispatchMetadata)!;
        assert.equal(resumed.businessResult, undefined); assert.equal(resumed.repairAttempts, 0);
        assert.equal(resumed.platformAttempts, progress.platformAttempts, 'Explicit continuation does not reset or spend infrastructure budget');
      }
      console.log(`agent-owned ${mode}: terminal business result, no reimplementation or condition wake, fixed evidence retained`);
      return;
    }
    if (rejectedReview) {
      assert.equal(after.status, 'attention', JSON.stringify(await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'asc' } }))); assert.equal(successorStarts, 0); assert.equal(starts, 1);
      assert.equal(reviews, mode === 'tester-model-drift' ? 0 : mode === 'tester-dirty' ? 1 : 2, 'Invalid receipt only gets one bounded recollection');
      if (mode !== 'tester-model-drift') assert.ok((after.evidence as any).checks.some((check: any) => !check.passed));
      console.log(`agent-owned ${mode}: rejected; no successor, no implementation restart, platform commands=0`);
      return;
    }
    assert.equal(after.status, mode === 'implement' ? 'delivered_unverified' : 'passed', JSON.stringify((await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: 'execution_outcome' }, orderBy: { createdAt: 'asc' } })).filter(event => (event.payload as any)?.outcome?.failure?.detail !== 'conditions_unchanged').map(event => event.payload)));
    if (mode === 'plain-delivery' || mode === 'history') assert.equal(starts, 2, 'Plain delivered evidence must request a formal Ticket conclusion in the original Session');
    else if (multiple) assert.ok(starts >= 2); else assert.equal(starts, ['repair', 'format', 'self-repair', 'self-defect', 'architecture'].includes(mode) ? 2 : 1);
    assert.equal(reviews, mode === 'repair' || mode === 'tester-auth' ? 2 : mode === 'tester' ? 1 : 0, 'Only the configured Tester starts a review');
    assert.equal(testerReviews, explicitReview ? reviews : 0);
    assert.ok(successorStarts >= definition.nodes[1].executions.length);
    if (mode === 'default') {
      for (let i = 0; i < 3; i++) { await releaseReadyNodes(run.id); await runTaskGraphCycle(); }
      await drain();
      assert.equal(successorStarts, 1, 'Repeated completion/release cycles must start B exactly once');
      const routeNodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, select: { id: true } });
      assert.equal(await prisma.taskRun.count({ where: { taskId: { in: routeNodes.flatMap(item => [`task-graph-review-${item.id}`, `task-graph-architecture-${item.id}`]) } } }), 0);
      assert.match(JSON.stringify(buildGraphNodeCard({ ...after, executions: [] })), /实施自测.*无独立验收/);
      const overview = JSON.stringify(buildGraphOverview(await loadGraphOverview(run.id)));
      assert.match(overview, /实施自测.*无独立验收/);
      assert.doesNotMatch(overview, /已完成 · 验收通过/);
      const evidence = after.evidence as any;
      assert.match(evidence.summary, /实施自测/);
      const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: node.executions[0].id } });
      assert.equal((job.evidence as any).integratedCommit, job.commit);
      assert.deepEqual(evidence.inputs, (job.evidence as any).ticketInputs);
      for (const invalid of ['missing', 'failed', 'stale'] as const) {
        const receipt = structuredClone(job.evidence) as any;
        if (invalid === 'missing') delete receipt.implementation.ticketVerification;
        if (invalid === 'failed') receipt.implementation.ticketVerification.approved = false;
        if (invalid === 'stale') receipt.integratedCommit = 'c'.repeat(40);
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { evidence: receipt } });
        await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: 'system', evidence }), /verification is missing or not passed/);
      }
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { evidence: job.evidence! } });
      await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: 'intruder', evidence }), /Wrong verification actor/);
      assert.deepEqual((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).snapshot, run.snapshot);
      console.log(`default proposal A -> B: A=${after.status}, self-test candidate=${job.commit}, review TaskRuns=0, B starts=${successorStarts}, platform business commands=${commands}`);
    }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'node_ready', node: { key: 'B' } } }), 1, 'Successor Ticket releases exactly once');
    if (multiple) {
      const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      assert.equal(codingTurns.get(mode === 'cross' ? 'A-other' : 'A-repo'), 1, 'Non-owner must not be requeued merely because another implementor changed the tree');
      assert.ok((codingTurns.get(mode === 'cross' ? 'A-repo' : 'A-other') || 0) <= 3, 'Only the approved owner verifies the final combination; timestamp reports must converge');
      assert.ok(codingTurns.has('A-repo') && codingTurns.has('A-other'));
    }
    if (mode === 'conflict') { assert.equal(conflictResolutions, 1); const final = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } }); assert.equal(git('show', `${final.commit}:shared`), 'repo\nother'); }
    if (mode === 'cross') assert.equal(jointRuns, 2, 'Both Tickets run actual joint commands against the pinned sibling repository');
    if (mode === 'history') { const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: node.executions[0].id } }); assert.equal((job.dispatchMetadata as any).progress.repairAttempts, 3); }
    assert.equal(commands, (reviews - (mode === 'tester-auth' ? 1 : 0)) * 2, 'Platform never executes the approved business command');
    if (mode === 'tester') {
      const evidence = after.evidence as any;
      assert.match(evidence.summary, /其他模型独立验收/);
      assert.equal(evidence.reviewReceipt.checks.length, 2);
      assert.equal(evidence.reviewReceipt.commits[0].commit, reviewedCommits[0]);
      await assert.rejects(() => submitNodeVerification({ runId: run.id, nodeKey: 'A', actorId: 'local:kimi-code', evidence: { ...evidence, reviewReceipt: undefined } }), /receipt/);
      for (let i = 0; i < 3; i++) { await releaseReadyNodes(run.id); await runTaskGraphCycle(); }
      await drain(); assert.equal(reviews, 1); assert.equal(successorStarts, 1);
      console.log(`explicit acceptance A -> B: reviews=${reviews}, Agent commands=${commands}, platform commands=0, fixed candidate=${reviewedCommits[0]}`);
    }
    if (mode === 'tester-auth' || mode === 'architecture-auth') {
      const failures = await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: 'verification_failed' } });
      assert.equal(failures.length, 1);
      const failed = (failures[0].payload as any).evidence;
      assert.match(failed.summary, /未完成.*401/);
      if (mode === 'architecture-auth') {
        assert.equal(failed.checks.find((item: any) => item.name === 'behavior').passed, true, 'Architecture authentication failure preserves passed Agent self-check');
        assert.equal(architectureStarts, 2);
      } else {
        assert.equal(after.evidence && (after.evidence as any).reviewReceipt.checks.length, 2);
        assert.equal(reviewedCommits[0], reviewedCommits[1]);
      }
      assert.equal(starts, 1); assert.equal(successorStarts, 1);
      assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'node_repair_scheduled' } }), 0);
      const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
      assert.equal(executionProgress(jobs[0].dispatchMetadata)?.platformAttempts, 1);
      for (let i = 0; i < 3; i++) { await releaseReadyNodes(run.id); await runTaskGraphCycle(); }
      await drain(); assert.equal(starts, 1); assert.equal(successorStarts, 1);
      assert.equal(mode === 'tester-auth' ? reviews : architectureStarts, 2, 'Duplicate scans cannot restart a completed phase');
      console.log(`agent-owned ${mode}: 401 retained delivery, one stage retry, no implementation restart, platform business commands=0`);
    }
    if (mode === 'repair') assert.notEqual(reviewedCommits[0], reviewedCommits[1]);
    if (mode !== 'implement') await assert.rejects(() => completeUnverifiedNode(run.id, 'A'), /approved implement-only/i);
    console.log(`agent-owned ${mode}: fixed quality, repair, human boundary, successor verified`);
  } finally {
    await drain(); adapter.execute = original.execute; adapter.resume = original.resume; independent.execute = original.tester; independent.resume = original.testerResume;
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.liveRoom.deleteMany({ where: { sourceTaskId: parent.id } });
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    for (const [key, value] of Object.entries(priorHomes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename), notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {}; notices.sendGraphHumanReviewCard = async () => {};
  require('../src/lib/task-graph/check-environment').runSandboxedGraphCheck = async () => { throw new Error('Agent-owned contracts must not execute platform business checks'); };
  require('../src/lib/real-agents/kimi-code-model-catalog').loadKimiCodeModelCatalog = async () => ({ 'fixture-kimi': {} });
  require('../src/lib/codex-model-catalog').loadCodexModelCatalog = async () => [{ id: 'fixture-codex', efforts: [], defaultEffort: null }];
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  require('../src/lib/scheduled-jobs/project-config').loadProjectsConfig = async () => ({ projects: [] });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  try { for (const mode of ['self-environment', 'self-human', 'environment-blocked', 'review-environment', 'review-human', 'architecture-environment', 'blocked', 'failed', 'needs-human', 'default', 'self', 'plain-delivery', 'history', 'cross', 'self-defect', 'multi', 'conflict', 'tester', 'tester-auth', 'architecture-auth', 'tester-missing', 'tester-sha', 'tester-dirty', 'tester-model-drift', 'human', 'repair', 'implement', 'format', 'full', 'self-repair', 'architecture'] as const) if (!process.env.GRAPH_QUALITY_CASE || process.env.GRAPH_QUALITY_CASE.split(',').includes(mode)) await scenario(mode); }
  finally { await prisma.$disconnect(); rmSync(fixtureRoot, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
