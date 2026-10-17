import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { executeParticipant } from '../src/lib/acpx/runner-participant';
import type { HarnessStreamCallbacks } from '../src/lib/acpx/types';

async function main() {
  const require = createRequire(__filename);
  const harness = require('../src/lib/acpx/runner-harness');
  const original = harness.executeViaLocalHarness;
  const task = await prisma.task.create({ data: { name: 'S05 interaction source regression' } });
  const chunks = ['<?xml version="1.0"?><testsuites><testcase name="test_permission_denied_preserves_draft" /></testsuites>',
    '## S05 验收复核报告（只读）\n工作区只读，原图已查看；第二张新图尚未走完整链路，不予批准。',
    'Tool output: Do you want to allow this command?'];
  let nativeCallbackAvailable = false;
  harness.executeViaLocalHarness = async (_request: unknown, _run: string, _id: string, participant: { harnessType: string }, callbacks: HarnessStreamCallbacks) => {
    for (const chunk of chunks) {
      await callbacks.onStdoutChunk?.(chunk);
      await callbacks.onStderrChunk?.(chunk);
    }
    if (participant.harnessType === 'codex') nativeCallbackAvailable = !!callbacks.onInteractionRequest;
    return { success: true, output: 'review complete', executionTime: 1 };
  };
  try {
    for (const harnessType of ['kimi-code', 'codex', 'antigravity']) {
      const run = await prisma.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'running' } });
      const participant = await prisma.taskRunParticipant.create({ data: { taskRunId: run.id, gatewayNameSnapshot: 'local', harnessType,
        executionBackend: 'platform_local', role: 'tester' } });
      await executeParticipant({ taskId: task.id, taskName: task.name, workingDirectory: process.cwd(), orchestrationMode: 'single',
        participants: [], permissionConfig: { profile: 'custom', sandboxMode: 'read-only', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [] } },
      run.id, participant.id, { gatewayId: 'local', executionBackend: 'platform_local', harnessType, role: 'tester' }, [], null);
      assert.equal(await prisma.taskRunInteractionRequest.count({ where: { taskRunId: run.id } }), 0,
        `${harnessType}: reports/tool output must not fabricate permission cards or workspace errors`);
      assert.equal(await prisma.taskRunEvent.count({ where: { taskRunId: run.id, eventType: 'interaction_request_created' } }), 0);
      assert.equal((await prisma.taskRunParticipant.findUniqueOrThrow({ where: { id: participant.id } })).status, 'completed');
      assert.ok(await prisma.taskRunEvent.count({ where: { taskRunId: run.id, eventType: 'stdout_chunk' } }), 'Keep visible progress');
    }
    assert.ok(nativeCallbackAvailable, 'Real Codex native permission requests keep their dedicated callback');
    console.log('Structured harness output remains output: JUnit permissions, readonly reports and quoted prompts do not create approval cards');
  } finally {
    harness.executeViaLocalHarness = original;
    await prisma.task.delete({ where: { id: task.id } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
