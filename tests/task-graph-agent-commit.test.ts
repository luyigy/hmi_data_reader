import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import { publishRoomResult } from '../src/lib/task-graph/room-result-publication';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { recordTaskRunResult } from '../src/lib/task-graph/task-run-result';
import { validateTaskGraphDefinition, taskGraphSnapshotHash } from '../src/lib/task-graph/domain';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { createTaskGraphRun, approveHumanNode } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema')!, /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'agent-commit-'));
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const notices = require('../src/lib/task-graph/feishu');
  notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  const worktree = require('../src/lib/task-graph/worktree');
  const checks = require('../src/lib/task-graph/check-environment');
  let platformCommits = 0, platformCommands = 0;
  const oldCommit = worktree.commitJobWorktree, oldCheck = checks.runSandboxedGraphCheck;
  worktree.commitJobWorktree = async (...args: unknown[]) => { platformCommits++; return oldCommit(...args); };
  checks.runSandboxedGraphCheck = async (...args: unknown[]) => { platformCommands++; return oldCheck(...args); };
  const adapter = getHarnessAdapter('codex')!;
  const original = { execute: adapter.execute, resume: adapter.resume };
  try {
    for (const mode of ['delivered', 'human', 'architecture', 'plain', 'working', 'blocked', 'failed', 'dirty', 'staged', 'missing-sha', 'wrong-sha', 'duplicate', 'foreign-branch', 'wrong-identity', 'room', 'restart', 'restart-failed', 'restart-blocked']) {
      if (process.env.GRAPH_COMMIT_CASE && !process.env.GRAPH_COMMIT_CASE.split(',').includes(mode)) continue;
      const repository = path.join(root, mode); mkdirSync(repository);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
      git('init', '-b', 'main'); git('config', 'user.name', 'Coding Agent'); git('config', 'user.email', 'agent@test');
      writeFileSync(path.join(repository, 'value'), 'base'); git('add', '.'); git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
      const definition = { deliveryContract: 'agent_commit_v1', specRef: 'test://agent-commit', nodes: ['A', 'B'].map(key => ({
        key, goal: 'Agent implements, tests and commits', dependsOn: key === 'B' ? ['A'] : [], executionMode: mode === 'architecture' && key === 'A' ? 'full' : 'lean',
        ...(mode === 'architecture' && key === 'A' ? { architectureReview: { reviewerId: 'local:codex', reviewLaunchConfig: { participant: { ...participant, role: 'reviewer' } } } } : {}),
        acceptance: { mode: mode === 'human' && key === 'A' ? 'human' : 'automatic', ...(mode === 'human' && key === 'A' ? { reviewerId: 'human' } : {}), checks: mode === 'delivered' ? [] : ['behavior'] },
        executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: base, agentSelector: 'local:codex', instructions: 'implement',
          launchConfig: { participant, checks: [{ name: 'behavior', argv: [process.execPath, '-e', 'throw Error("platform must not run this")'] }] } }],
      })) } as GraphDefinition;
      const legacy = { ...structuredClone(definition), deliveryContract: 'agent_owned_v1' as const };
      for (const node of legacy.nodes) if (!node.acceptance.checks.length) node.acceptance.checks = ['behavior'];
      assert.notEqual(taskGraphSnapshotHash({ ...definition, nodes: legacy.nodes }), taskGraphSnapshotHash(legacy));
      const multiple = structuredClone(definition); multiple.nodes[0].executions.push({ ...multiple.nodes[0].executions[0], key: 'other' });
      assert.throws(() => validateTaskGraphDefinition(multiple), /one execution/);
      const parent = await prisma.task.create({ data: { name: `agent-commit ${mode}` } });
      const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
      let starts = 0, successors = 0, architectures = 0, roomDelivery = false;
      const shas: string[] = [];
      adapter.execute = async args => {
        if (args.task.id.startsWith('task-graph-architecture-')) {
          architectures++;
          const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
          args.context.onSpawn?.(child); await once(child, 'exit');
          return { success: true, output: 'TASK_GRAPH_ARCH_REVIEW {"approved":false,"note":"An approved architecture gate is still pending a decision","failureKind":"blocked_require_human"}', executionTime: 1 };
        }
        const a = args.task.name.startsWith('A'); if (a) starts++; else successors++;
        const cwd = args.context.workingDirectory;
        const wrapped = wrapWithBubblewrap({ command: '/bin/sh', commandArgs: ['-ec',
          '! git update-ref refs/heads/main HEAD; ! git config --local fixture.escape true; printf good > value; test "$(cat value)" = good; git add value; git -c core.hooksPath=/dev/null commit --allow-empty -m "Agent delivery"; git rev-parse HEAD'],
          cwd, workspaceRoot: cwd, env: { ...process.env, ...args.context.taskEnvironment },
          writableRoots: args.context.extraWritableRoots, readOnlyPaths: args.context.extraReadOnlyPaths });
        const child = spawn(wrapped.command, wrapped.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
        args.context.onSpawn?.(child); const [code] = await once(child, 'exit');
        assert.equal(code, 0, stderr);
        const sha = stdout.trim().split('\n').at(-1)!; shas.push(sha);
        if (a && mode === 'dirty') writeFileSync(path.join(cwd, 'leftover'), 'uncommitted');
        if (a && mode === 'staged') { writeFileSync(path.join(cwd, 'value'), 'staged'); execFileSync('git', ['add', 'value'], { cwd }); }
        if (a && mode === 'foreign-branch') execFileSync('git', ['checkout', '--detach'], { cwd, stdio: 'pipe' });
        if (a && mode === 'wrong-identity') {
          const turn = await prisma.taskRun.findFirstOrThrow({ where: { taskId: args.task.id, status: 'running' } });
          const metadata = JSON.parse(turn.controlMetadata!); metadata.graphResultBinding.authorized = false;
          await prisma.taskRun.update({ where: { id: turn.id }, data: { controlMetadata: JSON.stringify(metadata) } });
        }
        const status = a && ['working', 'blocked', 'failed'].includes(mode) ? mode : 'delivered';
        let output = a && (mode === 'plain' || mode === 'room' && !roomDelivery) ? '普通聊天不是正式交付' : 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify({ status, note: 'Agent tested behavior', evidence: ['test value=good'],
          ...(a && mode === 'missing-sha' ? {} : { commit: a && mode === 'wrong-sha' ? base : sha }), ...(status === 'blocked' ? { blockerKind: 'missing_business_material' } : {}) });
        if (a && mode === 'duplicate') output += '\n' + output;
        return { success: true, output, executionTime: 1 };
      };
      adapter.resume = async args => adapter.execute(args);
      const drain = async () => { const controller = new AbortController(); controller.abort(); await startTaskGraphCoordinator(controller.signal); };
      if (mode.startsWith('restart')) {
        const crash = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register',
          'tests/fixtures/agent-commit-crash-worker.ts', mode === 'restart' ? 'delivered' : mode.slice(8)], { env: process.env, stdio: 'pipe' });
        let crashError = ''; crash.stderr.on('data', value => crashError += value); crash.stdout.resume();
        const [code] = await once(crash, 'exit'); assert.equal(code, 71, crashError);
        for (let i = 0; i < 30; i++) {
          await runTaskGraphCycle(); await drain();
          const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'A' } } });
          if (job.status === 'integrated' || executionProgress(job.dispatchMetadata)?.businessResult) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } else { await runTaskGraphCycle(); await drain(); }
      if (mode === 'room') {
        const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id, key: 'A' } } });
        assert.equal(job.commit, null); assert.equal(successors, 0); roomDelivery = true;
        const result = await executeAcpxTaskRun({ taskId: job.childTaskId!, taskName: 'A · room', workingDirectory: job.worktreePath!,
          participants: [participant], orchestrationMode: 'single' });
        assert.equal(result.status, 'completed');
        await Promise.all([publishRoomResult(result.taskRunId), publishRoomResult(result.taskRunId)]);
        assert.equal((await recordTaskRunResult(result.taskRunId))?.binding.source, 'room');
        shas.shift();
      }
      await runTaskGraphCycle(); await drain();
      const a = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } }, include: { executions: true } });
      if (['delivered', 'human', 'room', 'restart'].includes(mode)) {
        assert.equal(a.status, mode === 'human' ? 'awaiting_human' : 'passed', JSON.stringify(a.executions));
        if (mode !== 'restart') assert.equal(a.executions[0].commit, shas[0]);
        if (mode === 'human') { assert.equal(successors, 0); await approveHumanNode({ runId: run.id, nodeKey: 'A', reviewerId: 'human', approved: true, note: 'human-approval' }); }
        for (let i = 0; i < 3; i++) { await runTaskGraphCycle(); await drain(); }
        assert.equal(starts, mode === 'restart' ? 0 : mode === 'room' ? 2 : 1); assert.equal(successors, 1, 'Successor launches once');
      } else if (mode === 'architecture') {
        assert.equal(architectures, 1); assert.equal(a.status, 'attention'); assert.equal(successors, 0);
      } else {
        assert.notEqual(a.status, 'passed'); assert.equal(a.executions[0].commit, null); assert.equal(successors, 0);
      }
      if (mode === 'restart-failed' || mode === 'restart-blocked') { assert.equal(starts, 0, 'Restart never reruns a stopped business result'); assert.equal(executionProgress(a.executions[0].dispatchMetadata)?.businessResult, mode.slice(8)); }
      if (mode === 'delivered') {
        const receipt = await recordTaskRunResult(a.executions[0].taskRunId!);
        assert.equal(receipt?.binding.source, 'scheduled'); assert.equal(receipt?.result.kind, 'implementation');
        const published = await prisma.taskGraphEvent.count({ where: { nodeId: a.id, kind: 'node_passed' } });
        assert.equal(published, 1, 'Publication is idempotent');
      }
      assert.equal(git('rev-parse', 'refs/heads/main'), base, 'Agent cannot move the protected source branch');
      assert.deepEqual((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).snapshot, definition, 'Approved contract is immutable');
      await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'paused' } });
      assert.equal(platformCommits, 0); assert.equal(platformCommands, 0);
      console.log(`PASS ${mode}: platform business commands=0, platform commits=0`);
    }
  } finally {
    adapter.execute = original.execute; adapter.resume = original.resume;
    worktree.commitJobWorktree = oldCommit; checks.runSandboxedGraphCheck = oldCheck;
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
