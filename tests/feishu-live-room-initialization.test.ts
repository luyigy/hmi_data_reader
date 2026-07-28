import assert from 'node:assert/strict';
import { resolveNewFeishuRoomWorkingDirectory, UNBOUND_FEISHU_LIVE_ROOM_HINT } from '../src/lib/feishu-live-room';

assert.match(UNBOUND_FEISHU_LIVE_ROOM_HINT, /\/ap room --workdir=/);
assert.match(UNBOUND_FEISHU_LIVE_ROOM_HINT, /默认本机 Codex/);
assert.throws(() => resolveNewFeishuRoomWorkingDirectory({ chatType: 'group', workspaceRoot: '/default' }), /明确确认/);
assert.equal(resolveNewFeishuRoomWorkingDirectory({ chatType: 'group', confirmCreate: true, requestedWorkingDirectory: '/project', workspaceRoot: '/default' }), '/project');
assert.throws(() => resolveNewFeishuRoomWorkingDirectory({ chatType: 'group', confirmCreate: true, workspaceRoot: '/default' }), /显式设置/);
