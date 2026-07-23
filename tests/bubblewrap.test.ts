import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

void (async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ap-bwrap-'));
  const sharedAuth = path.join(await mkdtemp(path.join(tmpdir(), 'ap-bwrap-auth-')), 'auth.json');
  const roomAuth = path.join(root, 'auth.json');
  await writeFile(sharedAuth, '{}');
  await symlink(sharedAuth, roomAuth);
  const wrapped = wrapWithBubblewrap({ command: '/usr/bin/sh', commandArgs: ['-c', `test -w "$PWD" && test ! -e /etc/passwd && test -r /etc/ssl/certs/ca-certificates.crt && test -r ${JSON.stringify(roomAuth)}`], cwd: root, workspaceRoot: root, networkAccess: 'enabled', env: process.env, configPaths: [root] });
  assert.ok(wrapped.args.includes('--share-net'));
  assert.ok(wrapped.args.includes('/etc/ssl/certs'));
  assert.ok(wrapped.args.includes(sharedAuth));
  assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf('--bind'), wrapped.args.indexOf('--bind') + 3), ['--bind', root, root]);
  assert.ok(wrapped.args.includes('--tmpfs'));
  const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const fullAccess = wrapWithBubblewrap({ command: '/usr/bin/sh', commandArgs: ['-c', 'true'], cwd: root, networkAccess: 'enabled', env: process.env });
  assert.deepEqual(fullAccess, { command: '/usr/bin/sh', args: ['-c', 'true'] });

  const approvalSource = await readFile(path.join(process.cwd(), 'src/lib/feishu-access-approval.ts'), 'utf8');
  assert.equal(approvalSource.match(/networkAccess: 'enabled'/g)?.length, 3);
  assert.doesNotMatch(approvalSource, /networkAccess: 'restricted'/);
})();
