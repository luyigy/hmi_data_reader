import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeUpstream } from '../src/lib/task-graph/upstream-source';

async function main() {
  const repository = mkdtempSync(path.join(tmpdir(), 'upstream-capacity-'));
  const cache = repository + '-cache';
  const priorLimit = process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES;
  const priorRoot = process.env.TASK_GRAPH_UPSTREAM_ROOT;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    writeFileSync(path.join(repository, 'source.dat'), Buffer.alloc(2048, 7));
    git('add', '.'); git('commit', '-m', 'fixed approved source');
    const commit = git('rev-parse', 'HEAD');
    process.env.TASK_GRAPH_UPSTREAM_ROOT = cache;
    process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES = '2047';
    await assert.rejects(materializeUpstream(repository, commit), /宿主容量/);
    assert.equal(existsSync(cache), false, 'Capacity preflight rejects before allocating a snapshot');
    process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES = '2048';
    const snapshot = await materializeUpstream(repository, commit);
    assert.equal(git('hash-object', path.join(snapshot, 'source.dat')), git('rev-parse', 'HEAD:source.dat'));
    assert.equal(existsSync(path.join(snapshot, '.git')), false);
    process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES = '2047';
    await assert.rejects(materializeUpstream(repository, commit), /宿主容量/, 'Cached snapshots obey the current host capacity too');
    for (const invalid of ['0', '-1', 'NaN', 'Infinity', '1.5', '9007199254740992']) {
      process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES = invalid;
      await assert.rejects(materializeUpstream(repository, commit), /TASK_GRAPH_UPSTREAM_MAX_BYTES/);
    }
    console.log('Host capacity preflight, exact boundary, Git content identity, cache recheck and invalid configuration passed');
  } finally {
    if (priorLimit === undefined) delete process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES; else process.env.TASK_GRAPH_UPSTREAM_MAX_BYTES = priorLimit;
    if (priorRoot === undefined) delete process.env.TASK_GRAPH_UPSTREAM_ROOT; else process.env.TASK_GRAPH_UPSTREAM_ROOT = priorRoot;
    rmSync(repository, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
