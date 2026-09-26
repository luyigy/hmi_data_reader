import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { handleWorkspaceCommand } from '../src/lib/feishu-task-commands';

async function main() {
  const base = await mkdtemp(path.join(tmpdir(), 'ap-workspace-command-'));
  const root = path.join(base, 'user');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, 'escape'));
  await writeFile(path.join(base, 'file'), 'not a directory');
  const originalAdmin = process.env.FEISHU_ADMIN_OPEN_ID;
  const originals = [prisma.$queryRaw, prisma.$executeRaw, prisma.feishuUserAccess.findUnique,
    prisma.liveRoom.findUnique, prisma.task.update] as const;
  let workspaceRoot: string | null = null;
  const writes: unknown[] = [];
  process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
  prisma.$queryRaw = (async () => [{ liveRoomId: 'bound-room' }]) as typeof prisma.$queryRaw;
  prisma.$executeRaw = (async (_sql: unknown, ...values: unknown[]) => {
    writes.push(values);
    return 1;
  }) as typeof prisma.$executeRaw;
  prisma.feishuUserAccess.findUnique = (async () => ({ workspaceRoot })) as unknown as typeof prisma.feishuUserAccess.findUnique;
  prisma.liveRoom.findUnique = (async () => ({ id: 'bound-room', title: 'room', sourceTaskId: 'bound-task' })) as unknown as typeof prisma.liveRoom.findUnique;
  prisma.task.update = (async (args: unknown) => { writes.push(args); return {}; }) as typeof prisma.task.update;
  const run = (senderOpenId: string, directory?: string) => handleWorkspaceCommand(
    { command: 'workspace', args: directory ? [directory] : [], options: {} },
    { chatId: 'chat', chatType: 'p2p', senderOpenId, messageId: 'message' },
  );
  try {
    assert.match(await run('admin', outside), /工作目录已更新/);
    assert.deepEqual(writes.splice(0), [
      [outside, 'bound-room'],
      { where: { id: 'bound-task' }, data: { workingDirectory: outside } },
    ]);
    workspaceRoot = root;
    assert.match(await run('admin', outside), /工作目录已更新/);
    assert.match(await run('admin'), /管理员不受用户根目录限制/);
    writes.length = 0;
    await assert.rejects(run('admin', 'relative'), /绝对路径/);
    await assert.rejects(run('admin', path.join(base, 'missing')), /不存在/);
    await assert.rejects(run('admin', path.join(base, 'file')), /不是目录/);
    await assert.rejects(run('user', outside), /授权根目录内/);
    await assert.rejects(run('user', '../outside'), /授权根目录内/);
    await assert.rejects(run('user', 'escape'), /授权根目录内/);
    workspaceRoot = null;
    assert.match(await run('user', outside), /尚未配置授权根目录/);
    assert.match(await run('', outside), /无法识别/);
    assert.equal(writes.length, 0, 'rejected changes must not write');
    workspaceRoot = root;
    assert.match(await run('user', '.'), /工作目录已更新/);
    assert.deepEqual(writes[0], [root, 'bound-room']);
    console.log('Feishu workspace command tests passed');
  } finally {
    [prisma.$queryRaw, prisma.$executeRaw, prisma.feishuUserAccess.findUnique,
      prisma.liveRoom.findUnique, prisma.task.update] = originals;
    if (originalAdmin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID;
    else process.env.FEISHU_ADMIN_OPEN_ID = originalAdmin;
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
