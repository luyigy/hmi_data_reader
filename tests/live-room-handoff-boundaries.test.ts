import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const delivery = readFileSync('src/lib/live-room-delivery.ts', 'utf8');
const execution = readFileSync('src/lib/live-room-delivery-execution.ts', 'utf8');
const processing = readFileSync('src/lib/live-room-delivery-processing.ts', 'utf8');
const webMessages = readFileSync('src/app/api/live-rooms/[id]/messages/route.ts', 'utf8');
const feishuMessages = readFileSync('src/lib/feishu-live-room.ts', 'utf8');
const feishuWorkflow = readFileSync('src/lib/feishu-workflow.ts', 'utf8');
const interrupt = readFileSync('src/lib/live-room-interrupt.ts', 'utf8');
const migration = readFileSync(
  'prisma/migrations/20260729043000_add_live_room_handoff/migration.sql',
  'utf8',
);

assert.match(webMessages, /triggerLiveRoomMessageReplies\(\{/);
assert.match(feishuMessages, /triggerLiveRoomMessageReplies\(\{/);
assert.match(feishuWorkflow, /triggerLiveRoomMessageReplies\(\{[\s\S]*?allowHandoff: false/);
assert.ok(
  delivery.indexOf('setImmediate') < delivery.indexOf('dispatchLiveRoomHandoff(handoff)'),
  'handoff dispatch must be deferred until the current member queue releases',
);
assert.ok(
  processing.indexOf("deliveryStatus: 'delivered'") < processing.indexOf('const assistantMessage'),
  'the current delivery must be terminal before its assistant reply can request handoff',
);
assert.ok(
  processing.indexOf("presenceStatus: 'online'") < processing.indexOf('const assistantMessage'),
  'the current member must be released before its assistant reply can request handoff',
);
assert.match(delivery, /claimLiveRoomHandoff/);
assert.match(delivery, /waitForCompletion: false/);
assert.match(processing, /delivery\.handoffRootMessageId\s*\?/);
assert.match(interrupt, /deliveryStatus: 'superseded'[\s\S]*Cancelled by user before execution/);
assert.match(execution, /timed out after \\d\+ms[\s\S]*markLiveRoomSessionExpired[\s\S]*useFreshSession: true/);
assert.match(processing, /Remote SSH live room delivery became stale before completion[\s\S]*presenceStatus: 'online'/);
assert.match(migration, /"handoffLimit" INTEGER NOT NULL DEFAULT 4/);
assert.match(migration, /"handoffLimitSnapshot" INTEGER/);
assert.match(migration, /"handoffClaimStatus" TEXT/);
assert.match(migration, /"handoffRootMessageId" TEXT/);

console.log('Live Room handoff boundary checks passed');
