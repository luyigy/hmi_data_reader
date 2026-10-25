import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPermissionRequestWithinBoundary, nativePermissionResources, permissionResourceDirectory } from '../src/lib/acpx/interactions';
import { toCodexApprovalRequest } from '../src/lib/real-agents/codex-app-server';
import { handleHarnessInteractionRequest } from '../src/lib/acpx/runner-interactions';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../src/lib/acpx/permissions';
import { prisma } from '../src/lib/prisma';
import * as protocol from '../src/lib/task-resources/runner-protocol';
import type { AcpxRunRequest } from '../src/lib/acpx/types';

void (async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'native-boundary-'));
  const first = path.join(temp, 'first'), second = path.join(temp, 'second'), outside = path.join(temp, 'outside');
  for (const directory of [first, second, outside]) mkdirSync(directory);
  const file = path.join(outside, 'source.ts');
  writeFileSync(file, '');
  symlinkSync(outside, path.join(first, 'escape'));
  const fileRequest = (grantRoot: string) => toCodexApprovalRequest('item/fileChange/requestApproval', { grantRoot })!;
  const within = (grantRoot: string) => isPermissionRequestWithinBoundary({ ...fileRequest(grantRoot), writableRoots: [first, second] });
  assert.equal(within(path.join(second, 'new.ts')), true);
  assert.equal(within(file), false);
  assert.equal(within(path.join(first, 'escape/source.ts')), false);
  assert.equal(permissionResourceDirectory(file), outside);
  assert.equal(permissionResourceDirectory(path.join(outside, 'new/sub/file.ts')), outside);
  const permissions = { fileSystem: { write: [second], read: [outside] } };
  const turn = toCodexApprovalRequest('item/permissions/requestApproval', { permissions })!;
  assert.deepEqual(turn.nativePermission, { method: 'item/permissions/requestApproval', scope: 'turn', permissions });
  assert.equal(isPermissionRequestWithinBoundary({ ...turn, writableRoots: [first, second], readableRoots: [outside] }), true);
  assert.equal(isPermissionRequestWithinBoundary({ ...turn, writableRoots: [first, second] }), false);
  assert.equal(nativePermissionResources(toCodexApprovalRequest('item/permissions/requestApproval', { permissions: { network: { enabled: true } } })!), null);
  assert.equal(nativePermissionResources(fileRequest('')), null);
  assert.deepEqual(nativePermissionResources(toCodexApprovalRequest('item/permissions/requestApproval', {
    permissions: { network: null, fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: outside } }], read: null, write: null } },
  })!), [{ path: outside, access: 'write' }]);
  assert.equal(nativePermissionResources(toCodexApprovalRequest('item/permissions/requestApproval', {
    permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '/**' } }] } },
  })!), null);
  // The human-readable title and raw content cannot override a structured path.
  assert.equal(isPermissionRequestWithinBoundary({ ...fileRequest(file), title: 'other', rawContent: first, writableRoots: [first] }), false);

  const originalRun = prisma.taskRun.findUnique, originalParticipant = prisma.taskRunParticipant.findUnique;
  const originalFindInteraction = prisma.taskRunInteractionRequest.findFirst;
  const originalSubmit = protocol.submitRunnerResourceRequest;
  const mutableProtocol = protocol as { submitRunnerResourceRequest: typeof originalSubmit };
  let submitted: Parameters<typeof originalSubmit>[0] | undefined;
  prisma.taskRun.findUnique = (async () => ({ controlMetadata: '{}', taskSessionId: 'session' })) as unknown as typeof originalRun;
  prisma.taskRunParticipant.findUnique = (async () => ({ controlMetadata: JSON.stringify({ resources: { writableRoots: [second] } }) })) as unknown as typeof originalParticipant;
  mutableProtocol.submitRunnerResourceRequest = async args => { submitted = args; return 'blocked'; };
  const target = { executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' as const, gatewayId: 'local' };
  const runRequest: AcpxRunRequest = { taskId: 'task', taskName: 'Task', orchestrationMode: 'single', workingDirectory: first, participants: [target] };
  try {
    assert.equal(await handleHarnessInteractionRequest({ request: fileRequest(file), runRequest,
      taskId: 'task', taskRunId: 'run', participantId: 'participant', participant: { ...target, gatewayName: 'local' },
      workingDirectory: first, permissionConfig: { ...DEFAULT_ACPX_PERMISSION_CONFIG, writableRoots: [first] } }), 'deny');
    assert.equal(submitted?.request, runRequest);
    assert.equal(submitted?.participant, target);
    assert.equal(submitted?.participantId, 'participant');
    assert.deepEqual(protocol.parseResourceRequest(submitted!.output)?.resources, [{ path: outside, access: 'write' }]);
    prisma.taskRunInteractionRequest.findFirst = (() => { throw new Error('entered operation approval'); }) as typeof originalFindInteraction;
    // An actually applied grant enters ordinary approval instead of generating another resource request.
    await assert.rejects(handleHarnessInteractionRequest({ request: fileRequest(path.join(second, 'new.ts')), runRequest,
      taskId: 'task', taskRunId: 'run', participantId: 'participant', participant: { ...target, gatewayName: 'local' },
      workingDirectory: first, permissionConfig: { ...DEFAULT_ACPX_PERMISSION_CONFIG, writableRoots: [first] } }), /entered operation approval/);
  } finally {
    prisma.taskRunInteractionRequest.findFirst = originalFindInteraction;
    prisma.taskRun.findUnique = originalRun;
    prisma.taskRunParticipant.findUnique = originalParticipant;
    mutableProtocol.submitRunnerResourceRequest = originalSubmit;
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('Native resource boundary checks passed');
})();
