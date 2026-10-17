import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareAcceptanceRuntime } from '../src/lib/task-graph/acceptance-runtime';
import { archiveValidationResults } from '../src/lib/task-graph/validation-results';

async function main() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'validation-archive-'));
  const previous = process.env.TASK_GRAPH_VALIDATION_ROOT;
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  try {
    const one = await prepareAcceptanceRuntime('node', 'one', []);
    const two = await prepareAcceptanceRuntime('node', 'two', []);
    await fs.writeFile(path.join(one.directory, 'report.json'), '{"saved":true}');
    await fs.symlink('report.json', path.join(one.directory, 'report-link'));
    await fs.symlink(path.basename(one.directory), path.join(path.dirname(one.directory), 'current'));
    await fs.mkdir(path.join(two.directory, '.cache')); await fs.writeFile(path.join(two.directory, '.cache', 'discard'), 'cache');
    await fs.writeFile(path.join(two.directory, 'test.log'), 'passed');
    const archive = path.join(root, 'archive');
    const saved = await archiveValidationResults('node', archive);
    assert.equal(saved.files, 2);
    assert.equal(saved.symlinks, 2);
    const manifest = JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8'));
    assert.equal(manifest.links.length, 2, 'Internal aliases are recorded without following or recreating links');
    assert.equal(await fs.lstat(path.join(archive, 'files', path.basename(one.directory), 'report-link')).then(() => true, () => false), false);
    assert.equal(await fs.readFile(path.join(archive, 'files', path.basename(one.directory), 'report.json'), 'utf8'), '{"saved":true}');
    assert.equal(await fs.access(path.dirname(one.directory)).then(() => true, () => false), false);
    assert.deepEqual(await archiveValidationResults('node', archive), saved, 'Retry after deletion verifies archive and returns same receipt');
    await fs.writeFile(path.join(archive, 'files', path.basename(one.directory), 'report.json'), 'corrupt');
    await assert.rejects(archiveValidationResults('node', archive), /archive differs/);
    const blocked = await prepareAcceptanceRuntime('blocked', 'one', []);
    const secret = path.join(root, 'secret'); await fs.writeFile(secret, 'never follow');
    await fs.symlink(secret, path.join(blocked.directory, 'unsafe'));
    await assert.rejects(archiveValidationResults('blocked', path.join(root, 'blocked-archive')), /symlink/);
    assert.equal(await fs.readFile(secret, 'utf8'), 'never follow');
    assert.equal(await fs.access(blocked.directory).then(() => true, () => false), true);
    const active = await prepareAcceptanceRuntime('active', 'one', []);
    await fs.writeFile(path.join(active.directory, 'report'), 'keep');
    await assert.rejects(archiveValidationResults('active', path.join(root, 'active-archive'), async () => false), /active/);
    assert.equal(await fs.readFile(path.join(active.directory, 'report'), 'utf8'), 'keep');
    const changed = await prepareAcceptanceRuntime('changed', 'one', []);
    await fs.writeFile(path.join(changed.directory, 'report'), 'before');
    await assert.rejects(archiveValidationResults('changed', path.join(root, 'changed-archive'), async () => {
      await fs.writeFile(path.join(changed.directory, 'report'), 'after'); return true;
    }), /changed/);
    assert.equal(await fs.readFile(path.join(changed.directory, 'report'), 'utf8'), 'after');
    console.log('Validation archives verify every attempt before deletion; retries, corruption, symlinks, active work and changes retain evidence safely');
  } finally {
    if (previous === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
