import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deepSeekHarnessAdapter } from '../src/lib/harness/adapters/deepseek';
import { supportsRoomWorkspaceConstraint } from '../src/lib/feishu-room-controls';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

const run = async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'deepseek-test-'));
  const workspace = path.join(fixtureDir, 'workspace');
  await mkdir(workspace);

  try {
    // 1. Check getPermissionSupport for DeepSeek adapter under platform_local
    const permSupport = deepSeekHarnessAdapter.getPermissionSupport('platform_local');
    assert.equal(permSupport.sandboxMode, 'applied');
    assert.equal(permSupport.networkAccess, 'applied');
    assert.equal(permSupport.writableRoots, 'applied');
    assert.match(permSupport.summary, /Bubblewrap/);

    // 2. Check supportsRoomWorkspaceConstraint for deepseek on safe_local
    const supported = supportsRoomWorkspaceConstraint({
      harnessType: 'deepseek',
      backend: 'platform_local',
    }, 'safe_local');
    assert.equal(supported, true);

    // 3. Test Bubblewrap args wrapping for deepseek serve command
    const wrapped = wrapWithBubblewrap({
      command: 'deepseek',
      commandArgs: ['serve', '--', '--http', '--host', '127.0.0.1', '--port', '7788'],
      cwd: workspace,
      workspaceRoot: workspace,
      networkAccess: 'restricted',
      env: process.env,
    });
    assert.equal(wrapped.command, '/usr/bin/bwrap');
    assert.ok(wrapped.args.includes('--unshare-all'));
    assert.ok(!wrapped.args.includes('--share-net'));
    assert.ok(wrapped.args.includes(workspace));

    console.log('DeepSeek restricted mode & Bubblewrap tests passed');
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

void run();
