import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { buildFeishuUserDetailCard, buildFeishuUserListCard, handleFeishuUserAdminCardCallback } from '../src/lib/feishu-user-admin-card';
import { updateFeishuUserAdmin } from '../src/lib/feishu-user-admin';
import { handleFeishuInteractionCardAction } from '../src/lib/feishu-interaction-card-action';

process.env.FEISHU_ADMIN_OPEN_ID = 'ou_admin';

void (async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ap-feishu-user-admin-'));
  const user = { openId: 'ou_member', displayName: 'Member', status: 'approved', chatId: 'oc_member', workspaceRoot: workspace };
  let members: Array<Record<string, unknown>> = [];
  const room = { id: 'room_member', sourceTask: { id: 'task_member', name: 'Member task', acpxPermissionConfig: null }, get members() { return members; } };
  const writes: Array<{ kind: string; args: unknown }> = [];
  Object.assign(prisma.feishuUserAccess, {
    findUnique: async () => user,
    findMany: async () => [user],
    update: async (args: { data: { displayName: string } }) => { user.displayName = args.data.displayName; return user; },
  });
  Object.assign(prisma.feishuConversationBinding, {
    findFirst: async () => ({ liveRoomId: room.id }),
    findMany: async () => [{ chatId: user.chatId, senderOpenId: user.openId,
      liveRoom: { sourceTask: room.sourceTask, members: [{ memberType: 'local_agent', canReply: true,
        acpxPermissionConfig: JSON.stringify({ profile: 'dev_local' }) }] } }],
  });
  Object.assign(prisma.liveRoom, { findUnique: async () => room });
  Object.assign(prisma, {
    $transaction: async (action: (db: unknown) => Promise<unknown>) => action({
      feishuUserAccess: { update: async (args: unknown) => { writes.push({ kind: 'user', args }); return {}; } },
      liveRoom: { update: async (args: unknown) => { writes.push({ kind: 'room', args }); return {}; } },
      task: { update: async (args: unknown) => { writes.push({ kind: 'task', args }); return {}; } },
      liveRoomMember: { updateMany: async (args: unknown) => { writes.push({ kind: 'member', args }); return {}; } },
    }),
  });

  const denied = await handleFeishuUserAdminCardCallback({
    value: { cmd: 'feishu-user-admin', action: 'view', adminChatId: 'oc_admin' },
    formValue: { selectedUser: user.openId }, actorOpenId: 'ou_member', chatId: 'oc_admin',
  });
  assert.match(denied.toast?.content || '', /仅管理员/);
  const wrongChat = await handleFeishuUserAdminCardCallback({
    value: { cmd: 'feishu-user-admin', action: 'view', adminChatId: 'oc_other' },
    formValue: { selectedUser: user.openId }, actorOpenId: 'ou_admin', chatId: 'oc_admin',
  });
  assert.match(wrongChat.toast?.content || '', /原私聊/);
  const routed = await handleFeishuInteractionCardAction({
    cmd: 'feishu-user-admin', value: { action: 'view', adminChatId: 'oc_admin' },
    formValue: { selectedUser: user.openId }, openId: 'ou_admin', chatId: 'oc_admin',
    actorName: 'Admin', prefix: '[test]',
  });
  assert.ok(routed && 'card' in routed);

  const card = await buildFeishuUserDetailCard(user.openId, 'oc_admin');
  assert.match(JSON.stringify(card), /Member task/);
  assert.match(JSON.stringify(card), /\*\*姓名\*\*：Member/);
  assert.match(JSON.stringify(card), /授权根目录/);
  assert.match(JSON.stringify(card), /保存目录和权限/);
  assert.match(JSON.stringify(card), /撤销准入/);
  assert.ok(card.elements.some((element) => element.tag === 'form'));
  assert.equal((card.elements.find((element) => element.tag === 'form') as { elements: Array<{ tag: string; action_type?: string }> })
    .elements.find((element) => element.tag === 'button')?.action_type, 'form_submit');
  const list = await buildFeishuUserListCard('oc_admin');
  assert.match(JSON.stringify(list), /Member.*approved.*dev_local/);
  assert.match(JSON.stringify(list), /ap-feishu-user-admin/);
  assert.equal((list.elements.find((element) => element.tag === 'form') as { elements: Array<{ tag: string; action_type?: string }> })
    .elements.find((element) => element.tag === 'button')?.action_type, 'form_submit');

  const renamed = await handleFeishuUserAdminCardCallback({
    value: { action: 'saveName', userOpenId: user.openId, adminChatId: 'oc_admin' },
    formValue: { displayName: '张三' }, actorOpenId: 'ou_admin', chatId: 'oc_admin',
  });
  assert.match(JSON.stringify(renamed), /姓名已保存/);
  assert.match(JSON.stringify(renamed), /张三/);
  assert.match(JSON.stringify(await buildFeishuUserListCard('oc_admin')), /张三/);
  user.status = 'pending';
  const pendingCard = await buildFeishuUserDetailCard(user.openId, 'oc_admin');
  assert.match(JSON.stringify(pendingCard), /批准准入申请/);
  assert.match(JSON.stringify(pendingCard), /拒绝准入申请/);
  assert.match(JSON.stringify(pendingCard), /approvalWorkspaceRoot/);
  assert.match(JSON.stringify(pendingCard), /action_type":"form_submit/);
  assert.doesNotMatch(JSON.stringify(pendingCard), /此用户尚无已批准的私聊房间/);
  user.status = 'approved';

  await assert.rejects(updateFeishuUserAdmin({
    actorOpenId: 'ou_member', userOpenId: user.openId, workspaceRoot: workspace, profile: 'dev_local',
  }), /仅配置的飞书管理员/);
  assert.equal(writes.length, 0);

  members = [{ id: 'remote_agent', memberType: 'agent', canReply: true,
    backend: 'remote_ssh', harnessType: 'codex', displayName: 'Remote',
    acpxPermissionConfig: null }];
  await assert.rejects(updateFeishuUserAdmin({
    actorOpenId: 'ou_admin', userOpenId: user.openId, workspaceRoot: workspace, profile: 'dev_local',
  }), /不能真实应用/);
  assert.equal(writes.length, 0);
  members = [];

  const result = await updateFeishuUserAdmin({
    actorOpenId: 'ou_admin', userOpenId: user.openId, workspaceRoot: workspace, profile: 'dev_local',
  });
  assert.match(result, /Dev Local（联网）/);
  assert.deepEqual(writes.map(({ kind }) => kind), ['user', 'room', 'task']);
  const task = writes.find(({ kind }) => kind === 'task')!.args as { data: { workingDirectory: string; acpxPermissionConfig: string } };
  assert.equal(task.data.workingDirectory, workspace);
  assert.deepEqual(JSON.parse(task.data.acpxPermissionConfig), {
    profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'enabled',
    approvalPolicy: 'on-request', writableRoots: [workspace],
  });
})();
