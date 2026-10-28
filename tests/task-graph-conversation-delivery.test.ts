import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphTaskMessage, conversationInputs, bindConversationInputs, registerConversationSteering, deliverConversationSteering,
  reconcileConversationDeliveries, sealConversationTurn, recoverConversationInputs } from '../src/lib/task-graph/conversation-inbox';
import { observeTaskRunWriter, parseGraphWriter, createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';

async function main() {
  const require = createRequire(__filename); require('../src/lib/task-graph/feishu').postGraphChildProgress = async () => {};
  const parent = await prisma.task.create({ data: { name: 'conversation-delivery' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' };
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://delivery', nodes: [
    { key: 'A', goal: 'delivery', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [
      { key: 'repo', repository: '/tmp/delivery-proof', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'delivery', launchConfig: { participant, checks: [] } }] }] } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
  const childTask = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'delivery' } });
  await assert.rejects(executeAcpxTaskRun({ taskId: `task-graph-review-${job.nodeId}`, taskName: 'generic review bypass', orchestrationMode: 'single', participants: [] }), /not found|No .+ found|does not exist/i);
  const processWriter = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e',
    "require('./src/lib/task-graph/writer-ownership').createGraphWriter().then(w=>{process.stdout.write(JSON.stringify(w)+'\\n');setInterval(()=>{},1000)})"], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let detach = () => {};
  try {
    const [chunk] = await once(processWriter.stdout, 'data'); const writer = parseGraphWriter(JSON.parse(chunk.toString())); assert.ok(writer);
    const session = await prisma.taskSession.create({ data: { taskId: childTask.id } });
    const taskRun = await prisma.taskRun.create({ data: { taskId: childTask.id, taskSessionId: session.id, status: 'running', controlMetadata: JSON.stringify({ graphWriter: writer }),
      participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', runner: 'codex', status: 'running', controlMetadata: JSON.stringify({ lastSessionId: 'delivery-native', lastSessionKind: 'codex_thread' }) } } } });
    await prisma.taskSession.update({ where: { id: session.id }, data: { activeRunId: taskRun.id } });
    await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: 'claimed' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'claimed', claimToken: 'owner', taskRunId: taskRun.id, childTaskId: childTask.id,
      dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'implement', candidateCommit: 'a'.repeat(40), worker: writer, taskRunId: taskRun.id } } } });
    const sibling = await prisma.taskRun.create({ data: { taskId: childTask.id, taskSessionId: session.id, status: 'running' } });
    await prisma.taskSession.update({ where: { id: session.id }, data: { activeRunId: null } });
    await receiveGraphTaskMessage({ taskId: childTask.id, actorId: 'user', sourceId: 'unknown', content: 'Use size42' });
    let sends = 0;
    detach = registerConversationSteering(job.id, taskRun.id, async () => { sends++; return 'unknown'; });
    await deliverConversationSteering(); await deliverConversationSteering();
    assert.equal(sends, 1, 'Unknown native delivery is never blindly resent');
    await prisma.taskRun.delete({ where: { id: sibling.id } });
    await prisma.taskSession.update({ where: { id: session.id }, data: { activeRunId: taskRun.id } });
    assert.equal((await conversationInputs(job.id)).length, 0, 'Unknown delivery is reserved, not reported as unsent');
    await assert.rejects(sealConversationTurn(job.id, 'owner', 'a'.repeat(40)), /steering delivery is unknown/);
    assert.equal((await observeTaskRunWriter(taskRun.id)).kind, 'alive');
    await reconcileConversationDeliveries(); assert.equal((await conversationInputs(job.id)).length, 0, 'Live or unknown writer cannot be taken over');
    const exited = once(processWriter, 'exit'); processWriter.kill('SIGTERM'); await exited;
    assert.equal((await observeTaskRunWriter(taskRun.id)).kind, 'exited', 'Real child-process exit supplies takeover proof');
    const phase = await createGraphWriter();
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: { progress: { ...initialExecutionProgress(), phase: 'implement', worker: phase, taskRunId: taskRun.id } } } });
    await reconcileConversationDeliveries();
    assert.equal((await conversationInputs(job.id)).length, 0, 'Native writer exit while phase owner is still live is normal teardown, not failed delivery');
    await releaseGraphExecutionWorker(job.id, 'owner', phase.nonce);
    await Promise.all([reconcileConversationDeliveries(), reconcileConversationDeliveries()]);
    assert.equal((await conversationInputs(job.id)).length, 0, 'Unknown prior effects are not queued as fresh work');
    const recovered = await prisma.taskGraphEvent.findMany({ where: { runId: graph.id, kind: 'conversation_input_uncertain' } });
    assert.equal(recovered.length, 1); assert.match(JSON.stringify(recovered[0].payload), /禁止机械重放副作用/);
    await reconcileConversationDeliveries();
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_input_uncertain' } }), 1, 'Uncertain context remains durable and idempotent');
    detach();
    await receiveGraphTaskMessage({ taskId: childTask.id, actorId: 'user', sourceId: 'rejected', content: 'Explain progress' });
    detach = registerConversationSteering(job.id, taskRun.id, async () => { sends++; return 'rejected'; });
    await deliverConversationSteering(); await deliverConversationSteering();
    assert.equal(sends, 2, 'Rejected steering is attempted once, then remains queued for a normal turn');
    assert.equal((await conversationInputs(job.id)).length, 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_steering_started' } }), 2, 'Rejected delivery preserves the started audit event');
    await prisma.$transaction(tx => recoverConversationInputs(tx, job.id, taskRun.id));
    assert.equal((await conversationInputs(job.id)).filter(input => input.content.includes('Explain progress')).length, 1, 'Direct restart recovery does not duplicate explicitly rejected steering');
    const pending = await conversationInputs(job.id);
    await prisma.$transaction(tx => bindConversationInputs(tx, job.id, pending.map(input => input.id), taskRun.id));
    await prisma.taskRun.update({ where: { id: taskRun.id }, data: { status: 'failed' } });
    await reconcileConversationDeliveries();
    const failedRecovery = await conversationInputs(job.id);
    assert.equal(failedRecovery.length, 0, 'Failed bound startup is not proof of non-consumption');
    assert.ok((await prisma.taskGraphEvent.findMany({ where: { runId: graph.id, kind: 'conversation_input_uncertain' } })).some(event => JSON.stringify(event.payload).includes('Explain progress')), 'Original human input remains available for explicit reconciliation');
    const raceRun = await prisma.taskRun.create({ data: { taskId: childTask.id, taskSessionId: session.id, status: 'running', controlMetadata: JSON.stringify({ graphWriter: writer }),
      participants: { create: { gatewayNameSnapshot: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', runner: 'codex', status: 'running', controlMetadata: JSON.stringify({ lastSessionId: 'delivery-native', lastSessionKind: 'codex_thread' }) } } } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { taskRunId: raceRun.id } });
    await receiveGraphTaskMessage({ taskId: childTask.id, actorId: 'user', sourceId: 'completion-race', content: 'normal completion race' });
    const raceInput = (await conversationInputs(job.id)).find(input => input.sourceId === 'completion-race')!;
    await prisma.$transaction(tx => bindConversationInputs(tx, job.id, [raceInput.id], raceRun.id));
    const writerApi = require('../src/lib/task-graph/writer-ownership'); const realObservation = writerApi.observeTaskRunWriter;
    writerApi.observeTaskRunWriter = async (id: string) => { if (id === raceRun.id) await prisma.taskRun.update({ where: { id }, data: { status: 'completed', summary: 'native result saved' } }); return realObservation(id); };
    try { await reconcileConversationDeliveries(); } finally { writerApi.observeTaskRunWriter = realObservation; }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, idempotencyKey: `conversation-recovery:${raceInput.id}:${raceRun.id}` } }), 0, 'A fresh terminal status under row lock wins over a stale outer running snapshot');
    console.log('Actual writer exit fences uncertain delivery; unknown steering is never replayed, rejected input stays queued, failed bound turns retain explicit recovery context, concurrent reconciliation is idempotent.');
  } finally { detach(); processWriter.kill('SIGTERM'); await prisma.taskGraphRun.delete({ where: { id: graph.id } }); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
