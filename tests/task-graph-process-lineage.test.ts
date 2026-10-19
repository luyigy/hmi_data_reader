import assert from 'node:assert/strict';
import { hasIndependentProcessOrigin, type ProcessIdentity } from '../src/lib/task-graph/process-lineage';

async function main() {
  const owner = { pid: 20, startTime: '100' };
  const identities = new Map<number, ProcessIdentity>([
    [20, { pid: 20, parentPid: 10, startTime: '100', state: 'S' }],
    [10, { pid: 10, parentPid: 1, startTime: '10', state: 'S' }],
    [40, { pid: 40, parentPid: 30, startTime: '120', state: 'S' }],
    [30, { pid: 30, parentPid: 2, startTime: '110', state: 'S' }],
    [2, { pid: 2, parentPid: 1, startTime: '5', state: 'S' }],
  ]);
  const readIdentity = async (pid: number) => {
    const value = identities.get(pid); if (!value) throw new Error('Process identity unavailable'); return { ...value };
  };
  const probe = () => hasIndependentProcessOrigin({ pid: 40, owner, readIdentity });
  assert.equal(await probe(), true, 'A stable branch rooted in an independent pre-existing server cannot inherit a newly spawned harness nonce');
  identities.set(30, { pid: 30, parentPid: 20, startTime: '110', state: 'S' });
  assert.equal(await probe(), false, 'A writer descendant remains a possible nonce holder');
  identities.set(30, { pid: 30, parentPid: 10, startTime: '110', state: 'S' });
  assert.equal(await probe(), false, 'A common ancestor may have adopted a nonce orphan');
  identities.set(30, { pid: 30, parentPid: 1, startTime: '110', state: 'S' });
  assert.equal(await probe(), false, 'A PID1 orphan has no independent origin proof');
  identities.set(30, { pid: 30, parentPid: 999, startTime: '110', state: 'S' });
  assert.equal(await probe(), false, 'Missing ancestors do not prove exit');
  identities.set(30, { pid: 30, parentPid: 2, startTime: '110', state: 'S' });
  for (const changed of [{ parentPid: 1 }, { startTime: '999' }, { state: 'Z' }]) {
    const reads = new Map<number, number>();
    const unstable = async (pid: number) => {
      const count = (reads.get(pid) || 0) + 1; reads.set(pid, count);
      const identity = await readIdentity(pid);
      return pid === 30 && count > 1 ? { ...identity, ...changed } : identity;
    };
    assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner, readIdentity: unstable }), false, 'Reparenting, PID reuse and exit during observation remain unknown');
  }
  assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner: { ...owner, startTime: '99' }, readIdentity }), false);
  const absentOwner = async (pid: number) => {
    if (pid === 20) throw Object.assign(new Error('exited'), { code: 'ENOENT' });
    return readIdentity(pid);
  };
  const ancestry = [{ pid: 20, parentPid: 10, startTime: '100' }, { pid: 10, parentPid: 1, startTime: '10' }];
  assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner, ancestry, readIdentity: absentOwner }), true,
    'A captured owner ancestry survives supervisor exit without skipping candidate scanning');
  assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner, readIdentity: absentOwner }), false);
  identities.set(30, { pid: 30, parentPid: 10, startTime: '110', state: 'S' });
  assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner, ancestry, readIdentity: absentOwner }), false);
  identities.set(30, { pid: 30, parentPid: 2, startTime: '110', state: 'S' });
  identities.set(10, { pid: 10, parentPid: 1, startTime: '999', state: 'S' });
  assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner, ancestry, readIdentity: absentOwner }), false, 'Reused historical ancestors cannot authorize takeover');
  identities.set(10, { pid: 10, parentPid: 1, startTime: '10', state: 'S' });
  identities.set(20, { pid: 20, parentPid: 11, startTime: '100', state: 'S' });
  identities.set(11, { pid: 11, parentPid: 1, startTime: '9', state: 'S' });
  identities.set(30, { pid: 30, parentPid: 10, startTime: '110', state: 'S' });
  assert.equal(await hasIndependentProcessOrigin({ pid: 40, owner, ancestry, readIdentity }), false,
    'Stable reparenting since capture cannot turn a historical common ancestor into an independent service');
  console.log('Independent old process branches are excluded only with stable identities; live descendants, adopted orphans, missing ancestry and changed PIDs remain unproven');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
