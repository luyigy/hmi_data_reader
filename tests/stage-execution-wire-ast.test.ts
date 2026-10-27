import assert from 'node:assert/strict';
import { checkStageExecutionWire } from '../scripts/check-stage-execution-wire';

const runner = 'src/lib/acpx/runner-harness.ts';
const dispatch = 'src/lib/acpx/stage-harness-dispatch.ts';
const coordinator = 'src/lib/task-graph/coordinator.ts';
const fixture = new Map([
  [runner, `
    const before = captureStageAuthority(request, taskRunId);
    const stage = StageExecutionRequest.create(input);
    const fresh = captureStageAuthority(request, taskRunId);
    executePreparedStageHarness(stage);
    executeRemoteRunnerTask({prompt:harnessContinuationInput(request, participant, prepared)});
    executeRemoteSshTask(task, {continuationMessage:harnessContinuationInput(request, participant, prepared)});
  `],
  [dispatch, `
    function executePreparedStageHarness(stageRequest, authority, runtime, request, participant, task, adapter) {
      if (isGraphStageRequest(request) && !stageRequest) throw new Error('Stage request required');
      stageRequest.assertMatches({authority, runtime});
      const message = stageRequest ? stageRequest.prompt : harnessContinuationInput(request, participant, task.description || '');
      const currentTask = {...task, description:message};
      if (participant.resumeSessionId) return adapter.resume({task:currentTask, continuationMessage:message});
      return adapter.execute({task:currentTask});
    }
  `],
  ['src/lib/acpx/prompt.ts', `
    function harnessContinuationInput(request, participant, prepared) {
      return isGraphStageRequest(request) || !participant.continuationMessage ? prepared : participant.continuationMessage;
    }
  `],
  [coordinator, `import {executeAcpxTaskRun, implementationConversation} from './boundary';
    implementationConversation(id, participant); executeAcpxTaskRun(request);`],
  ['src/lib/task-graph/review-result.ts', `import {executeAcpxTaskRun} from '../acpx/runner'; executeAcpxTaskRun(request);`],
]);
assert.deepEqual(checkStageExecutionWire(fixture), [], 'Representative registered AST topology must pass');
let mutants = 0;
function reject(name: string, file: string, before: string, after: string, expected: RegExp) {
  const source = fixture.get(file)!;
  assert.ok(source.includes(before), `${name}: mutation must modify its intended expression`);
  const files = new Map(fixture); files.set(file, source.replace(before, after));
  const findings = checkStageExecutionWire(files);
  assert.ok(findings.some(item => expected.test(item.message)), `${name}: actionable W001 finding required: ${JSON.stringify(findings)}`);
  mutants++;
}
reject('missing stage refusal', dispatch, "if (isGraphStageRequest(request) && !stageRequest) throw new Error('Stage request required');", '', /refuse a missing/);
reject('old Resume input', dispatch, 'continuationMessage:message', 'continuationMessage:participant.continuationMessage', /identical current-stage/);
reject('wrong first-start task', dispatch, 'adapter.execute({task:currentTask})', 'adapter.execute({task})', /identical current-stage/);
reject('missing current-stage validation', dispatch, 'stageRequest.assertMatches({authority, runtime});', '', /validate stageRequest/);
reject('wrong validation authority', dispatch, '{authority, runtime}', '{authority: oldAuthority, runtime}', /validate stageRequest/);
reject('alternate task description', dispatch, 'description:message', 'description:participant.continuationMessage', /identical validated/);
reject('old finalization source', dispatch, 'stageRequest.prompt', 'participant.continuationMessage', /select stageRequest.prompt/);
reject('direct runner dispatch', runner, 'executePreparedStageHarness(stage)', 'adapter.resume(input)', /Direct adapter lifecycle/);
reject('missing contract constructor', runner, 'StageExecutionRequest.create(input)', 'input', /construct StageExecutionRequest/);
reject('missing fresh capture', runner, 'const fresh = captureStageAuthority(request, taskRunId);', '', /fresh before dispatch/);
reject('third session message', coordinator, 'implementationConversation(id, participant)', 'implementationConversation(id, participant, message)', /separate stage message/);
reject('new direct call', coordinator, 'executeAcpxTaskRun(request);', 'executeAcpxTaskRun(request); executeAcpxTaskRun(other);', /callsite count/);
reject('remote stale input', runner, 'prompt:harnessContinuationInput(request, participant, prepared)', 'prompt:participant.continuationMessage', /Remote prompt/);
reject('remote SSH stale input', runner, 'continuationMessage:harnessContinuationInput(request, participant, prepared)', 'continuationMessage:participant.continuationMessage', /Remote continuationMessage/);
reject('graph selector uses historical prompt', 'src/lib/acpx/prompt.ts', '? prepared :', '? participant.continuationMessage :', /return prepared/);
reject('negated graph selector', 'src/lib/acpx/prompt.ts', 'isGraphStageRequest(request) ||', '!isGraphStageRequest(request) ||', /return prepared/);
reject('element-access dispatch bypass', runner, 'executePreparedStageHarness(stage)', "adapter['resume'](input)", /Direct adapter lifecycle/);
for (const [name, source] of [
  ['named import alias', `import { executeAcpxTaskRun as launch } from '../acpx/runner'; launch(request);`],
  ['namespace import', `import * as runner from '../acpx/runner'; runner.executeAcpxTaskRun(request);`],
  ['namespace element access', `import * as runner from '../acpx/runner'; runner['executeAcpxTaskRun'](request);`],
] as const) {
  const files = new Map(fixture); files.set('src/lib/task-graph/unregistered-stage.ts', source);
  assert.ok(checkStageExecutionWire(files).some(item => /callsite count/.test(item.message)), `${name}: new Graph caller must fail`);
  mutants++;
}
const renamed = new Map(fixture);
renamed.set(coordinator, `import {executeAcpxTaskRun as launch} from '../acpx/runner'; launch(request);`);
assert.deepEqual(checkStageExecutionWire(renamed), [], 'Registered import aliases remain supported');
console.log(`W001 AST mutation matrix: ${mutants} structural counterexamples rejected`);
assert.deepEqual(checkStageExecutionWire(), [], 'Current repository must satisfy the same gate');
console.log(`W001 AST boundary gate passed; ${mutants} structural counterexamples rejected`);
