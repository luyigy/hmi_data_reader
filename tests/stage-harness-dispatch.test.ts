import assert from 'node:assert/strict';
import type * as DispatchModule from '../src/lib/acpx/stage-harness-dispatch';
const { executePreparedStageHarness, stageRuntimeContract }: typeof DispatchModule = require(process.env.W001_DISPATCH_MODULE || '../src/lib/acpx/stage-harness-dispatch');
import { StageExecutionRequest, type StageAuthority } from '../src/lib/acpx/stage-execution-request';
import type { HarnessExecutionContext, HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';
import type { AcpxParticipantRequest, AcpxRunRequest } from '../src/lib/acpx/types';

async function main() {
  const participant: AcpxParticipantRequest = { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', continuationMessage: 'old session: edit source directly' };
  const request: AcpxRunRequest = { taskId: 'task-graph-fixture', taskName: 'fixture', orchestrationMode: 'single', participants: [participant],
    graphExecution: { executionId: 'job', claimToken: 'claim', revision: 9, inputIds: ['material'] } };
  const authority: StageAuthority = { kind: 'execution', taskRunId: 'task-run', ...request.graphExecution!, phase: 'conflict_repair', candidateCommit: 'a'.repeat(40), sourceRoots: ['/source'] };
  const context: HarnessExecutionContext = { workingDirectory: '/runtime', workspaceRoot: '/runtime', executionBackend: 'platform_local', timeout: null,
    permissionConfig: { profile: 'custom', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [] },
    networkAccess: 'restricted', extraReadOnlyPaths: ['/source'], extraWritableRoots: [],
    taskEnvironment: { AP_GRAPH_OUTPUT_DIR: '/outputs/current', AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: '/outputs/current', target: '/outputs/current', readOnly: false }]) } };
  const task = { id: request.taskId, name: request.taskName, description: 'Current conflict stage: readonly source; resolution.json at /outputs/current; material received.' };
  const stageRequest = StageExecutionRequest.create({ authority, runtime: stageRuntimeContract(context), prompt: task.description });
  const calls: { mode: string; input: HarnessExecuteArgs | HarnessResumeArgs }[] = [];
  const adapter = {
    execute: async (input: HarnessExecuteArgs) => { calls.push({ mode: 'execute', input }); return { success: true, output: 'ok', executionTime: 0 }; },
    resume: async (input: HarnessResumeArgs) => { calls.push({ mode: 'resume', input }); return { success: true, output: 'ok', executionTime: 0 }; },
  };
  const args = { adapter, request, participant, task, context, stageRequest, authority };
  await executePreparedStageHarness(args);
  await executePreparedStageHarness({ ...args, participant: { ...participant, resumeSessionId: 'original-native-session' } });
  assert.deepEqual(calls.map(call => call.mode), ['execute', 'resume']);
  assert.equal(calls[0].input.task.description, stageRequest.prompt);
  const resumed = calls[1].input;
  assert('continuationMessage' in resumed);
  assert.equal(resumed.continuationMessage, stageRequest.prompt, 'Resume must send the current finalized stage, including outputs and material');
  assert.equal(resumed.task.description, resumed.continuationMessage);
  assert.equal(resumed.sessionId, 'original-native-session');

  const rejected = async (label: string, changes: Partial<Parameters<typeof executePreparedStageHarness>[0]>) => {
    const before = calls.length;
    await assert.rejects(executePreparedStageHarness({ ...args, ...changes }), /W001/, label);
    assert.equal(calls.length, before, `${label} must fail before model dispatch`);
    console.log(`W001 rejected before dispatch: ${label}`);
  };
  await rejected('missing request', { stageRequest: null });
  await rejected('candidate drift', { authority: { ...authority, candidateCommit: 'b'.repeat(40) } });
  await rejected('claim drift', { authority: { ...authority, claimToken: 'other' } });
  await rejected('revision drift', { authority: { ...authority, revision: 10 } });
  await rejected('input identity drift', { authority: { ...authority, inputIds: ['different-material'] } });
  const manifest = structuredClone(context); manifest.taskEnvironment!.TASK_GRAPH_UPSTREAM_INPUTS_JSON = '[{"hash":"different"}]';
  await rejected('input manifest drift', { context: manifest });
  await rejected('stage switch without rebuilding', { authority: { ...authority, phase: 'collect_result' } });
  const writable = structuredClone(context); writable.extraWritableRoots = ['/source'];
  await rejected('permissions/source write drift', { context: writable });
  const network = structuredClone(context); network.networkAccess = 'enabled';
  await rejected('network mismatch', { context: network });
  const output = structuredClone(context); output.taskEnvironment!.AP_GRAPH_OUTPUT_DIR = '/outputs/stale';
  await rejected('output directory drift', { context: output });
  const redirect = structuredClone(context);
  redirect.taskEnvironment!.AP_GRAPH_OUTPUT_BINDINGS_JSON = JSON.stringify([{ source: '/outputs/current', target: '/source', readOnly: false }]);
  await rejected('output binding drift', { context: redirect });

  const nextAuthority: StageAuthority = { ...authority, phase: 'collect_result', revision: 10 };
  const nextPrompt = 'Collect current result only; fixed candidate and current output.';
  const next = StageExecutionRequest.create({ authority: nextAuthority, runtime: stageRuntimeContract(context), prompt: nextPrompt });
  await executePreparedStageHarness({ ...args, stageRequest: next, authority: nextAuthority, participant: { ...participant, resumeThreadId: 'original-native-session' } });
  assert.equal(calls.at(-1)?.input.task.description, nextPrompt, 'Same native Session accepts a newly validated stage');
  const ordinary = { ...request, graphExecution: undefined };
  await executePreparedStageHarness({ ...args, request: ordinary, stageRequest: null, authority: null, participant: { ...participant, resumeSessionId: 'chat' } });
  assert.match(calls.at(-1)?.input.task.description || '', /old session: edit source directly/, 'Ordinary chat retains its existing continuation');
  await executePreparedStageHarness({ ...args, request: ordinary, stageRequest: null, authority: null });
  assert.equal(calls.at(-1)?.input.task.description, task.description, 'Cleared/invalid ordinary Session starts with prepared task, not stale continuation');
  console.log('W001 first start, Resume, stage switch and ordinary-chat compatibility passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
