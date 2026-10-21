import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graphGit, graphGitJsonPairDigest } from '../src/lib/task-graph/git-command';

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'graph-digest-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
    const suffix = [['source', 'hash']];
    const bodies = ['', '  ', '中文😀"\\\n\tend\r\n  ', ('中文😀"\\\n' + 'x'.repeat(81)).repeat(70000) + '\n \t'];
    for (const body of bodies) {
      writeFileSync(path.join(directory, 'payload'), body); git('add', '.'); git('commit', '--allow-empty', '-m', 'fixture');
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) await assert.rejects(graphGit(directory, 'show', 'HEAD:payload'), /maxBuffer|ENOBUFS|length exceeded/);
      const expected = createHash('sha256').update(JSON.stringify([body.trimEnd(), suffix])).digest('hex');
      assert.equal(await graphGitJsonPairDigest(directory, ['show', 'HEAD:payload'], suffix), expected, 'New streaming hash must preserve existing checkpoint bytes');
    }
    console.log('Git fingerprint: >4MiB output, UTF-8 boundaries, JSON escaping, empty output and trailing whitespace match the existing digest without enlarging buffers');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
