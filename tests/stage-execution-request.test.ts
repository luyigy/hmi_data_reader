import assert from 'node:assert/strict';
import { StageExecutionRequest, W001StageContractError, type StageAuthority, type StageRuntimeContract } from '../src/lib/acpx/stage-execution-request';

const candidate = 'a'.repeat(40);
const authority: StageAuthority = { kind: 'execution', taskRunId: 'task-run', executionId: 'execution', claimToken: 'claim', revision: 7,
  phase: 'conflict_repair', candidateCommit: candidate, sourceRoots: ['/repo/worktree'] };
const runtime: StageRuntimeContract = {
  workingDirectory: '/runtime', workspaceRoot: '/runtime',
  permissionConfig: { profile: 'custom', sandboxMode: 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [] },
  extraReadOnlyPaths: ['/repo/worktree'], extraWritableRoots: ['/private/home'], outputDirectory: '/outputs/attempt',
  outputBindings: JSON.stringify([{ source: '/outputs/attempt', target: '/outputs/attempt', readOnly: false }]),
};
const prompt = 'Current conflict stage: source readonly; write resolution.json with complete resolved text in AP_GRAPH_OUTPUT_DIR.';
const input = () => structuredClone({ authority, runtime, prompt });
const request = StageExecutionRequest.create(input());
request.assertMatches(input());
assert.equal(request.prompt, prompt);
assert.match(request.identity, /^[a-f0-9]{64}$/);
assert.equal(StageExecutionRequest.create(input()).identity, request.identity);

const drift = (change: (value: ReturnType<typeof input>) => void, pattern = /W001/) => {
  const value = input(); change(value);
  assert.throws(() => request.assertMatches(value), pattern);
};
drift(value => { if (value.authority.kind === 'execution') value.authority.candidateCommit = 'b'.repeat(40); });
drift(value => { if (value.authority.kind === 'execution') value.authority.claimToken = 'new-claim'; });
drift(value => { if (value.authority.kind === 'execution') value.authority.revision++; });
drift(value => { if (value.authority.kind === 'execution') value.authority.phase = 'implement'; });
drift(value => { value.runtime.permissionConfig.networkAccess = 'restricted'; });
drift(value => { value.runtime.permissionConfig.writableRoots.push('/repo'); }, /W001.*writable root/);
drift(value => { value.runtime.extraWritableRoots.push('/repo/worktree/file'); }, /W001.*writable root/);
drift(value => { value.runtime.extraReadOnlyPaths = []; }, /W001.*readonly mount/);
drift(value => { value.runtime.workingDirectory = '/repo/worktree'; }, /W001.*working directory/);
drift(value => { value.runtime.outputDirectory = '/outputs/other'; }, /W001.*binding/);
drift(value => { value.runtime.outputBindings = JSON.stringify([{ source: '/other', target: '/outputs/attempt', readOnly: false }]); });
drift(value => { value.runtime.outputBindings = JSON.stringify([
  { source: '/outputs/attempt', target: '/outputs/attempt', readOnly: false },
  { source: '/outputs/attempt', target: '/repo/worktree/file', readOnly: false },
]); }, /W001/);

const aliased = input();
aliased.runtime.outputBindings = JSON.stringify([
  { source: '/outputs/attempt', target: '/outputs/attempt', readOnly: false },
  { source: '/outputs/attempt/legacy/reports', target: '/repo/worktree/reports', readOnly: false },
]);
const aliasedRequest = StageExecutionRequest.create(aliased);
aliasedRequest.assertMatches(aliased);
const redirected = structuredClone(aliased);
redirected.runtime.outputBindings = redirected.runtime.outputBindings.replace('/repo/worktree/reports', '/repo/worktree/another');
assert.throws(() => aliasedRequest.assertMatches(redirected), /W001.*runtime drift/);
const sourceRootAlias = structuredClone(aliased);
sourceRootAlias.runtime.outputBindings = sourceRootAlias.runtime.outputBindings.replace('/repo/worktree/reports', '/repo/worktree');
assert.throws(() => StageExecutionRequest.create(sourceRootAlias), /W001.*protected source/);

const callerOwned = input();
const immutable = StageExecutionRequest.create(callerOwned);
callerOwned.runtime.extraWritableRoots.push('/new');
assert.throws(() => immutable.assertMatches(callerOwned), W001StageContractError);
immutable.assertMatches(input());
assert.ok(Object.isFrozen(immutable));
assert.throws(() => Object.assign(immutable, { prompt: 'old implementation' }), TypeError);

for (const malformed of ['', '{}', 'null', '[{}]']) {
  const value = input(); value.runtime.outputBindings = malformed;
  assert.throws(() => StageExecutionRequest.create(value), W001StageContractError);
}
const missing = input();
if (missing.authority.kind === 'execution') missing.authority.sourceRoots = [];
assert.throws(() => StageExecutionRequest.create(missing), /W001.*fixed source/);
const unrestricted = input(); unrestricted.runtime.permissionConfig.sandboxMode = 'danger-full-access';
assert.throws(() => StageExecutionRequest.create(unrestricted), /W001.*unrestricted/);

for (const phase of ['architecture', 'acceptance'] satisfies ('architecture' | 'acceptance')[]) {
  const reviewAuthority: StageAuthority = { kind: 'review', taskRunId: 'task-run', runId: 'run', nodeId: 'node', phase, claimKey: 'review-claim',
    candidates: [{ repository: '/original/repo', commit: candidate }], sourceRoots: ['/repo/worktree'] };
  const review = StageExecutionRequest.create({ authority: reviewAuthority, runtime, prompt: 'Review fixed candidate.' });
  review.assertMatches({ authority: reviewAuthority, runtime });
  const changed = structuredClone(reviewAuthority); changed.candidates[0].commit = 'c'.repeat(40);
  assert.throws(() => review.assertMatches({ authority: changed, runtime }), /W001.*authority drift/);
  const readonlyRuntime = structuredClone(runtime); readonlyRuntime.permissionConfig.sandboxMode = 'read-only';
  StageExecutionRequest.create({ authority: reviewAuthority, runtime: readonlyRuntime, prompt });
}
const conversationAuthority: StageAuthority = { kind: 'conversation', taskRunId: 'task-run', executionId: 'execution', reservationId: 'reservation', candidateCommit: candidate };
assert.throws(() => StageExecutionRequest.create({ authority: conversationAuthority, runtime, prompt }), /W001.*conversation/);
const readonlyRuntime = structuredClone(runtime); readonlyRuntime.permissionConfig.sandboxMode = 'read-only';
assert.throws(() => StageExecutionRequest.create({ authority: conversationAuthority, runtime: readonlyRuntime, prompt }), /retired/);
const ordinaryAuthority: StageAuthority = { ...authority, phase: 'implement' };
const ordinaryRuntime = structuredClone(runtime);
ordinaryRuntime.workingDirectory = '/repo/worktree'; ordinaryRuntime.workspaceRoot = '/repo/worktree';
StageExecutionRequest.create({ authority: ordinaryAuthority, runtime: ordinaryRuntime, prompt: 'Implement approved ticket.' });
console.log('W001 immutable contract: candidate, claim/revision, stage, permissions, output binding and source protections passed.');
