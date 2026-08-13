import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

void (async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ap-bwrap-'));
  const parent = path.dirname(root);
  const sibling = await mkdtemp(path.join(tmpdir(), 'ap-bwrap-sibling-'));
  const shared = await mkdtemp(path.join(tmpdir(), 'ap-bwrap-config-'));
  const external = await mkdtemp(path.join(tmpdir(), 'ap-bwrap-external-'));
  const sharedAuth = path.join(shared, 'auth.json');
  const externalAuth = path.join(external, 'auth.json');
  const linkedAuth = path.join(shared, 'linked-auth.json');
  const hostTmpSecret = path.join(tmpdir(), `ap-bwrap-host-${process.pid}`);
  const parentSecret = path.join(parent, `ap-bwrap-parent-${process.pid}`);
  const siblingSecret = path.join(sibling, 'secret');
  const roomAuth = path.join(root, 'auth.json');
  const escape = path.join(root, 'escape');
  await mkdir(path.join(root, 'nested'));
  await writeFile(sharedAuth, '{}');
  await writeFile(externalAuth, '{"linked":true}');
  await symlink(externalAuth, linkedAuth);
  await writeFile(hostTmpSecret, 'host');
  await writeFile(parentSecret, 'parent');
  await writeFile(siblingSecret, 'sibling');
  await symlink(sharedAuth, roomAuth);
  await symlink(sibling, escape);
  const command = [
    'test -w "$PWD"',
    'echo ok > project-write',
    'test ! -e /etc/passwd',
    'test ! -e /var/run/docker.sock',
    `test ! -e ${JSON.stringify(hostTmpSecret)}`,
    `test ! -e ${JSON.stringify(parentSecret)}`,
    `test ! -e ${JSON.stringify(siblingSecret)}`,
    `test ! -e ${JSON.stringify(escape)}/secret`,
    'test -r /etc/ssl/certs/ca-certificates.crt',
    'test -r /etc/hosts',
    'test -r /etc/resolv.conf',
    'test -r /sys/devices/system/cpu/online',
    'test -d /sys/devices/system/node',
    `test -r ${JSON.stringify(roomAuth)}`,
    `! echo changed > ${JSON.stringify(roomAuth)}`,
    `test -r ${JSON.stringify(linkedAuth)}`,
    `! echo changed > ${JSON.stringify(linkedAuth)}`,
  ].join(' && ');
  const wrapped = wrapWithBubblewrap({ command: '/usr/bin/sh', commandArgs: ['-c', command], cwd: path.join(root, 'nested', '..'), workspaceRoot: root, networkAccess: 'enabled', env: process.env, configPaths: [root], readOnlyPaths: [shared] });
  assert.ok(wrapped.args.includes('--share-net'));
  assert.ok(wrapped.args.includes('/etc/ssl/certs'));
  assert.ok(wrapped.args.includes('/etc/hosts'));
  assert.ok(wrapped.args.includes('/etc/resolv.conf'));
  assert.ok(wrapped.args.includes('/sys/devices/system/cpu'));
  assert.ok(wrapped.args.includes('/sys/devices/system/node'));
  assert.ok(wrapped.args.includes(shared));
  assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf('--bind'), wrapped.args.indexOf('--bind') + 3), ['--bind', root, root]);
  assert.ok(wrapped.args.includes('--tmpfs'));
  const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(root, 'project-write'), 'utf8'), 'ok\n');
  assert.equal(await readFile(sharedAuth, 'utf8'), '{}');
  assert.throws(
    () => wrapWithBubblewrap({ command: '/usr/bin/sh', commandArgs: ['-c', 'true'], cwd: sibling, workspaceRoot: root, env: process.env }),
    /outside the authorized workspace/,
  );
  assert.throws(
    () => wrapWithBubblewrap({ command: '/usr/bin/sh', commandArgs: ['-c', 'true'], cwd: escape, workspaceRoot: root, env: process.env }),
    /outside the authorized workspace/,
  );

  const fullAccess = wrapWithBubblewrap({ command: '/usr/bin/sh', commandArgs: ['-c', 'true'], cwd: root, networkAccess: 'enabled', env: process.env });
  assert.deepEqual(fullAccess, { command: '/usr/bin/sh', args: ['-c', 'true'] });

  const withExtra = wrapWithBubblewrap({
    command: '/usr/bin/sh',
    commandArgs: ['-c', 'true'],
    cwd: root,
    workspaceRoot: root,
    networkAccess: 'enabled',
    env: process.env,
    writableRoots: [sibling, path.join(root, 'nested'), sibling],
  });
  const writableBinds = withExtra.args
    .map((arg, index) => (arg === '--bind' ? withExtra.args[index + 1] : null))
    .filter((arg) => arg !== null);
  assert.ok(writableBinds.includes(sibling));
  assert.ok(!writableBinds.includes(path.join(root, 'nested')));
  assert.equal(writableBinds.filter((arg) => arg === sibling).length, 1);

  const approvalSource = await readFile(path.join(process.cwd(), 'src/lib/feishu-access-approval.ts'), 'utf8');
  assert.equal(approvalSource.match(/networkAccess: 'enabled'/g)?.length, 3);
  assert.doesNotMatch(approvalSource, /networkAccess: 'restricted'/);
})();
