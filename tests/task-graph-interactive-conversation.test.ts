import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { getHarnessAdapter } from '../src/lib/harness';
import { executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphTaskMessage, conversationInputs } from '../src/lib/task-graph/conversation-inbox';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-interactive-'));
  const repos = ['reader', 'mold'].map(name => { const dir = path.join(root, name); mkdirSync(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(path.join(dir, 'source'), name); git('add', '.'); git('commit', '-m', 'base');
    return { dir, base: git('rev-parse', 'HEAD') }; });
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const require = createRequire(__filename); const feishu = require('../src/lib/task-graph/feishu');
  const notices: string[] = []; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async (_task: string, _key: string, text: string) => { notices.push(text); };
  const adapter = getHarnessAdapter('codex')!; const saved = { execute: adapter.execute, resume: adapter.resume };
  const calls: { task: string; session: string | null; directory: string; readOnly: boolean; prompt: string }[] = [];
  const native = 'original-reader-native-session';
  let legacyRunId: string | null = null; let legacyTurns = 0; let materialInputId: string | undefined;
  let readerTurns = 0; let releaseMold: () => void = () => {}; const moldRunning = new Promise<void>(resolve => { releaseMold = resolve; });
  async function run(args: HarnessExecuteArgs | HarnessResumeArgs) {
    const resume = 'sessionId' in args ? args.sessionId : null;
    const prompt = 'continuationMessage' in args ? args.continuationMessage : args.task.description || '';
    calls.push({ task: args.task.id, session: resume, directory: args.context.workingDirectory, readOnly: args.context.permissionConfig?.sandboxMode === 'read-only', prompt });
    const processChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(processChild); await once(processChild, 'exit');
    const execution = await prisma.taskGraphExecution.findUnique({ where: { childTaskId: args.task.id }, include: { node: true } });
    if (execution?.node.runId === legacyRunId) {
      if (args.context.permissionConfig?.sandboxMode === 'read-only') {
        const inputs = prompt.split('\n').filter(line => line.startsWith('{"id":')).map(line => JSON.parse(line));
        if (inputs.some(input => input.content === '尺寸材料是42，只检查不要继续')) return { success: true, output: '尺寸材料已收到，先核对。', sessionId: 'legacy-followup', sessionKind: 'codex_thread', executionTime: 1 };
        const input = inputs.find(input => input.content.includes('尺寸材料'));
        return { success: true, output: 'TASK_GRAPH_CONVERSATION ' + JSON.stringify({ action: 'resume_implementation', inputIds: [materialInputId || input.id], note: '材料已提供' }), sessionId: 'legacy-followup', sessionKind: 'codex_thread', executionTime: 1 };
      }
      if (execution.key === 'peer') return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"permission_required","note":"需要额外授权，不得因兄弟材料恢复而放行"}', sessionId: 'peer-native', sessionKind: 'codex_thread', executionTime: 1 };
      legacyTurns++;
      if (legacyTurns === 1) return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"missing_business_material","note":"需要尺寸材料"}', sessionId: 'legacy-native', sessionKind: 'codex_thread', executionTime: 1 };
      assert.equal(resume, 'legacy-followup', 'Legacy material handoff preserves the original conversation lineage');
      writeFileSync(path.join(args.context.workingDirectory, 'done'), 'legacy fixed');
      return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"material incorporated","evidence":["done"]}', sessionId: 'legacy-followup', sessionKind: 'codex_thread', executionTime: 1 };
    }
    if (args.context.permissionConfig?.sandboxMode === 'read-only' && prompt.includes('FAIL_NATIVE')) return { success: false, error: 'permanent-native-failure', executionTime: 1 };
    if (args.context.permissionConfig?.sandboxMode === 'read-only') return { success: true, output: '已完成，保留原交付。', sessionId: native + '-followup', sessionKind: 'codex_thread', executionTime: 1 };
    const reader = args.context.workingDirectory.includes('jobs') && (await prisma.taskGraphExecution.findUnique({ where: { childTaskId: args.task.id } }))?.key === 'reader';
    if (reader) {
      readerTurns++;
      if (readerTurns === 1) { await moldRunning; writeFileSync(path.join(args.context.workingDirectory, 'half'), 'saved');
        return { success: true, output: '使用哪个尺寸？\nTASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"missing_business_material","note":"请告诉我尺寸"}', sessionId: native, sessionKind: 'codex_thread', executionTime: 1 }; }
      assert.equal(resume, native, 'Ordinary answer resumes the original native session');
      if (readerTurns === 2) { assert.match(prompt, /尺寸使用42/);
        await receiveGraphTaskMessage({ taskId: args.task.id, actorId: human.id, actorOrigin: 'platform', sourceId: 'late-correction', content: '颜色使用蓝色' });
        return { success: true, output: '尺寸42已记入，正在核对新颜色。', sessionId: native, sessionKind: 'codex_thread', executionTime: 1 };
      } else assert.match(prompt, /颜色使用蓝色/, 'A correction queued before sealing must run before integration');
    } else releaseMold();
    writeFileSync(path.join(args.context.workingDirectory, 'done'), 'verified');
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"implemented","evidence":["done"]}', sessionId: reader ? native : 'native-other', sessionKind: 'codex_thread', executionTime: 1 };
  }
  adapter.execute = run; adapter.resume = run;
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const human = await prisma.user.create({ data: { username: root, passwordHash: 'fixture-only', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'interactive two repos', ownerUserId: human.id } });
  const definition = { specRef: 'test://interactive', nodes: [
    ...repos.map((repo, index) => ({ key: index === 0 ? 'R' : 'M', goal: index === 0 ? 'reader' : 'mold', dependsOn: [],
      executionMode: 'full' as const, acceptance: { mode: 'automatic' as const, checks: ['done'] },
      executions: [{ key: index === 0 ? 'reader' : 'mold', repository: repo.dir, gitRef: 'refs/heads/main', baseCommit: repo.base,
        agentSelector: 'local:codex', instructions: 'Implement approved scope', launchConfig: { participant, checks: [{ name: 'done', argv: ['node', '-e', "require('fs').accessSync('done')"] }] } }] })),
    { key: 'NEXT', goal: 'downstream', dependsOn: ['R', 'M'], executionMode: 'implement' as const, acceptance: { mode: 'automatic' as const, checks: [] }, executions: [
      { key: 'next', repository: repos[0].dir, gitRef: 'refs/heads/main', baseCommit: repos[0].base, agentSelector: 'local:codex', instructions: 'downstream', launchConfig: { participant, checks: [] } }] },
  ] };
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  async function until(predicate: () => Promise<boolean>) { for (let n = 0; n < 400; n++) { await runTaskGraphCycle(); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(JSON.stringify(await prisma.taskGraphExecution.findMany({ where: { node: { runId: graph.id } } }))); }
  try {
    await until(async () => (await prisma.taskGraphNode.count({ where: { runId: graph.id, key: 'M', status: 'passed' } })) === 1 &&
      (await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id, key: 'R' } } })).status === 'attention');
    const reader = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id, key: 'R' } } });
    const before = executionProgress(reader.dispatchMetadata)!; assert.equal(before.state, 'waiting_for_user'); assert.equal(before.formatAttempts, 0); assert.equal(before.platformAttempts, 0);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: graph.id, key: 'NEXT' } } })).status, 'planned');
    const answer = { taskId: reader.childTaskId!, sourceId: 'answer-42', actorId: human.id, actorOrigin: 'platform' as const, content: '尺寸使用42' };
    await Promise.all([receiveGraphTaskMessage(answer), receiveGraphTaskMessage(answer)]);
    assert.equal((await conversationInputs(reader.id)).length, 1);
    await until(async () => (await prisma.taskGraphNode.count({ where: { runId: graph.id, key: 'NEXT', status: 'delivered_unverified' } })) === 1);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } });
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_reserved' } }), 0, 'Material and ordinary answers use the implementation entry without a read-only handoff');
    assert.equal(executionProgress(after.dispatchMetadata)!.formatAttempts, 0, 'A normal successful answer needs no result recovery');
    assert.equal(readerTurns, 3); assert.equal(after.worktreePath, reader.worktreePath);
    assert.equal(executionProgress(after.dispatchMetadata)!.platformAttempts, 0); assert.equal(executionProgress(after.dispatchMetadata)!.repairAttempts, 0);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_review_recovery_requested' } }), 0);
    console.log(JSON.stringify({ event: 'normal-material-continuation', executionId: reader.id, before: { status: reader.status, taskRunId: reader.taskRunId, claim: reader.claimToken, progress: before }, after: { status: after.status, taskRunId: after.taskRunId, claim: after.claimToken, progress: executionProgress(after.dispatchMetadata) }, nativeTurns: calls.filter(call => call.task === reader.childTaskId), inputReceipts: await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_input_bound' } }) }));
    const evidence = JSON.stringify(after.evidence); const commit = after.commit;
    await receiveGraphTaskMessage({ ...answer, sourceId: 'followup-1', content: '完成了哪些？' });
    await until(async () => calls.some(call => call.task === reader.childTaskId && call.readOnly));
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    const unchanged = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } });
    assert.equal(unchanged.commit, commit); assert.equal(JSON.stringify(unchanged.evidence), evidence);
    assert.equal(calls.filter(call => call.task === reader.childTaskId).length, 4);
    await receiveGraphTaskMessage({ ...answer, sourceId: 'followup-2', content: '上一条答复能再解释一下吗？' });
    await until(async () => calls.filter(call => call.task === reader.childTaskId && call.readOnly).length === 2);
    const done = new AbortController(); done.abort(); await startTaskGraphCoordinator(done.signal);
    const followups = calls.filter(call => call.task === reader.childTaskId && call.readOnly);
    assert.equal(followups[0].session, native);
    assert.equal(followups[1].session, native + '-followup', 'Second followup resumes native identity returned by first followup');
    writeFileSync(path.join(followups[1].directory, 'source'), 'dirty fixed artifact');
    await receiveGraphTaskMessage({ ...answer, sourceId: 'dirty-followup', content: '再问一下状态' });
    await until(async () => (await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_deferred' } })) === 1);
    const failedAttempt = new AbortController(); failedAttempt.abort(); await startTaskGraphCoordinator(failedAttempt.signal);
    for (let n = 0; n < 4; n++) await runTaskGraphCycle();
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_deferred' } }), 1, 'Permanent setup failure is backed off instead of spawning a reservation every cycle');
    assert.ok(notices.some(text => text.includes('Fixed conversation workspace identity changed')), 'Deferred input gets its specific failure and next action in the topic outbox');
    const clock = Date.now; Date.now = () => clock() + 16_000;
    try { await runTaskGraphCycle(); const drained = new AbortController(); drained.abort(); await startTaskGraphCoordinator(drained.signal); } finally { Date.now = clock; }
    for (let n = 0; n < 3; n++) await runTaskGraphCycle();
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_deferred' } }), 2, 'An unchanged setup failure is attempted at most twice');
    writeFileSync(path.join(followups[1].directory, 'source'), 'reader');
    const nativeBefore = calls.filter(call => call.task === reader.childTaskId && call.readOnly).length;
    await receiveGraphTaskMessage({ ...answer, sourceId: 'native-failure', content: 'FAIL_NATIVE' });
    await until(async () => calls.filter(call => call.task === reader.childTaskId && call.readOnly).length > nativeBefore);
    const failDrain = new AbortController(); failDrain.abort(); await startTaskGraphCoordinator(failDrain.signal);
    Date.now = () => clock() + 16_000;
    try { await runTaskGraphCycle(); const drained = new AbortController(); drained.abort(); await startTaskGraphCoordinator(drained.signal); } finally { Date.now = clock; }
    for (let n = 0; n < 4; n++) await runTaskGraphCycle();
    assert.equal(calls.filter(call => call.task === reader.childTaskId && call.readOnly).length, nativeBefore + 2, 'Native-failure recovery keeps root input lineage and cannot reset the two-attempt budget with new input IDs');

    const owner = await prisma.user.create({ data: { username: parent.id, passwordHash: 'fixture-only', role: 'admin' } });
    const legacyParent = await prisma.task.create({ data: { name: 'legacy-material', ownerUserId: owner.id } });
    const legacy = await createTaskGraphRun({ parentTaskId: legacyParent.id, version: 1, requestKey: legacyParent.id, definition: {
      specRef: 'test://legacy-material', nodes: [{ key: 'LEGACY', goal: 'legacy-material', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
        executions: repos.map((repo, index) => ({ key: index ? 'peer' : 'reader', repository: repo.dir, gitRef: 'refs/heads/main', baseCommit: repo.base,
          agentSelector: 'local:codex', instructions: 'approved material scope', launchConfig: { participant, checks: [] } })) }] } });
    legacyRunId = legacy.id;
    await until(async () => (await prisma.taskGraphExecution.count({ where: { node: { runId: legacy.id }, status: 'attention' } })) === 2);
    const legacyJob = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: legacy.id }, key: 'reader' } });
    // Persist an old-format material pause explicitly: new waits must not replace legacy compatibility coverage.
    const legacyProgress = executionProgress(legacyJob.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: legacyJob.id }, data: { issueKind: 'missing_business_material', dispatchMetadata: metadataWithProgress(legacyJob.dispatchMetadata, { ...legacyProgress, state: 'waiting_decision', lastFailure: { code: 'missing_business_material', detail: '需要尺寸材料' } }) } });
    await receiveGraphTaskMessage({ taskId: legacyJob.childTaskId!, sourceId: 'untrusted-material', actorId: 'not-owner', actorOrigin: 'platform', content: '尺寸材料是42' });
    await receiveGraphTaskMessage({ taskId: legacyJob.childTaskId!, sourceId: 'owner-status', actorId: owner.id, actorOrigin: 'platform', content: '现在进度如何？' });
    await until(async () => calls.filter(call => call.task === legacyJob.childTaskId && call.readOnly).length === 1);
    const denied = new AbortController(); denied.abort(); await startTaskGraphCoordinator(denied.signal);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: legacyJob.id } })).status, 'attention', 'An unrelated owner status question cannot authorize another user material handoff');
    await receiveGraphTaskMessage({ taskId: legacyJob.childTaskId!, sourceId: 'legacy-answer', actorId: owner.id, actorOrigin: 'platform', content: '尺寸材料是42，只检查不要继续' });
    materialInputId = (await conversationInputs(legacyJob.id))[0].id;
    await until(async () => calls.filter(call => call.task === legacyJob.childTaskId && call.readOnly).length === 2);
    const checked = new AbortController(); checked.abort(); await startTaskGraphCoordinator(checked.signal);
    assert.equal((await conversationInputs(legacyJob.id)).length, 0, 'The earlier material was already processed by a normal conversation turn');
    await receiveGraphTaskMessage({ taskId: legacyJob.childTaskId!, sourceId: 'continue-earlier-material', actorId: owner.id, actorOrigin: 'platform', content: '按刚才的尺寸继续实施' });
    await until(async () => calls.filter(call => call.task === legacyJob.childTaskId && call.readOnly).length === 3);
    const continuation = new AbortController(); continuation.abort(); await startTaskGraphCoordinator(continuation.signal);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: legacy.id, kind: 'implementation_recovery_scheduled' } }), 1,
      'An authorized continuation can cite material from an earlier turn of the same execution');
    await until(async () => (await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: legacyJob.id } })).status === 'integrated');
    const peer = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: legacy.id }, key: 'peer' } });
    assert.equal(peer.status, 'attention'); assert.equal(executionProgress(peer.dispatchMetadata)!.lastFailure!.code, 'permission_required');
    assert.equal(legacyTurns, 2); assert.equal(executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: legacyJob.id } })).dispatchMetadata)!.repairAttempts, 0);
    console.log('Two repositories run concurrently; normal human reply resumes the same execution/native session; waiting spends no budget; verified delivery unlocks downstream; completed followup protects fixed evidence.');
  } finally { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal); adapter.execute = saved.execute; adapter.resume = saved.resume;
    if (legacyRunId) await prisma.taskGraphRun.delete({ where: { id: legacyRunId } }); await prisma.taskGraphRun.delete({ where: { id: graph.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
