import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import type { AcpxRunRequest } from '../src/lib/acpx/types';
import { decideResourceAccess, resolveResourceAccess } from '../src/lib/task-resources/access';
import { drainResourceApprovals, reconcileResourceApprovals } from '../src/lib/task-resources/reconcile';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';

export async function finalOutputRegression(cwd: string, source: string) {
  const adapter = getHarnessAdapter('codex')!;
  const original = { execute: adapter.execute, resume: adapter.resume };
  const envelope = `<resource-request>${JSON.stringify({ purpose: 'final output fixture', resources: [{ path: source, access: 'read' }] })}</resource-request>`;
  let mode = '', calls = 0;
  adapter.execute = adapter.resume = async args => {
    calls++;
    const stream = args.context.streamCallbacks?.onStdoutChunk;
    await stream?.('过程播报', { id: 'progress', phase: 'commentary' });
    await stream?.(mode === 'quoted' ? '示例：' + envelope : mode === 'malformed' ? '<resource-request>{broken}</resource-request>' : envelope,
      { id: 'final', phase: mode === 'unknown' ? null : mode === 'commentary' ? 'commentary' : 'final_answer', operation: 'replace' });
    if (mode === 'multiple') await stream?.(envelope, { id: 'second', phase: 'final_answer' });
    if (mode === 'probe') {
      assert(!args.context.extraReadOnlyPaths?.includes(source), 'Denied access must not enter the harness context');
      const plan = prepareSandboxEnvironment({ command: process.execPath, commandArgs: ['-e', `require('assert/strict').equal(require('fs').existsSync(${JSON.stringify(source)}),false)`],
        cwd, workspaceRoot: cwd, writableRoots: args.context.extraWritableRoots, readOnlyPaths: args.context.extraReadOnlyPaths,
        sandboxMode: 'workspace-write', networkAccess: 'restricted', env: { ...process.env, ...args.context.taskEnvironment } });
      const command = renderBubblewrap(plan);
      const child = spawn(command.command, command.args, { env: plan.env, stdio: 'pipe' });
      args.context.onSpawn?.(child);
      let error = ''; child.stderr.on('data', text => { error += text; });
      assert.equal((await once(child, 'exit'))[0], 0, error);
      await stream?.('拒绝后目录仍不可用', { id: 'final', phase: 'final_answer', operation: 'replace' });
    }
    await args.context.onSessionStarted?.({ sessionId: 'final-output-native', sessionKind: 'codex_thread' });
    return { success: mode !== 'failed', output: envelope, error: mode === 'failed' ? 'fixture failure after final' : undefined,
      sessionId: 'final-output-native', sessionKind: 'codex_thread', executionTime: 1 };
  };
  try {
    for (mode of ['unknown', 'commentary', 'multiple', 'quoted', 'malformed', 'failed', 'denied']) {
      const task = await prisma.task.create({ data: { name: `final-${mode}`, workingDirectory: cwd } });
      const launch: AcpxRunRequest = { taskId: task.id, taskName: task.name, orchestrationMode: 'single', workingDirectory: cwd,
        participants: [{ gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'custom' }],
        permissionConfig: { profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [cwd] } };
      const result = await executeAcpxTaskRun(launch);
      const requests = await prisma.feishuAdminApproval.findMany({ where: { kind: 'task_resources', payloadJson: { contains: task.id } } });
      assert.equal(requests.length, mode === 'denied' ? 1 : 0, mode + ' must not infer an approval from mixed/ambiguous/failed output');
      assert.equal(result.status, ['malformed', 'failed'].includes(mode) ? 'failed' : 'completed', mode);
      if (mode === 'denied') {
        const before = calls;
        await decideResourceAccess({ id: requests[0].id, revision: 1, actorOpenId: 'runtime-resource-admin', action: 'deny' });
        await reconcileResourceApprovals(requests[0].id); await drainResourceApprovals();
        assert.equal(calls, before, 'Denial does not resume the Agent');
        assert.deepEqual(await resolveResourceAccess(launch), { approvalIds: [], resources: [] });
        mode = 'probe';
        const probe = await executeAcpxTaskRun({ ...launch, participants: launch.participants.map(p => ({ ...p, resumeSessionId: 'final-output-native', continuationSessionKind: 'codex_thread' })) });
        assert.equal(probe.status, 'completed');
      }
    }
  } finally { adapter.execute = original.execute; adapter.resume = original.resume; }
}
