import assert from 'node:assert';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';
import {
  isUsefulLiveRoomThinkingPreview,
  shouldRelayLiveRoomStdoutProgress,
} from '../src/lib/live-room-delivery-execution';

async function runTest() {
  console.log('[Test] Testing FeishuProgressTracker system info collapsible panel...');

  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const tracker = new FeishuProgressTracker('test-chat-123', '/srv/agent-platform');
  let flushCount = 0;
  (tracker as any).maybeFlush = async () => { flushCount += 1; };

  assert.equal(shouldRelayLiveRoomStdoutProgress('codex'), true);
  assert.equal(shouldRelayLiveRoomStdoutProgress('kimi-code'), true);
  assert.equal(shouldRelayLiveRoomStdoutProgress('pi-agent'), true);
  assert.equal(shouldRelayLiveRoomStdoutProgress('antigravity'), true);
  assert.equal(isUsefulLiveRoomThinkingPreview('I'), false);
  assert.equal(isUsefulLiveRoomThinkingPreview('I will inspect the delivery path.'), true);
  assert.equal(isUsefulLiveRoomThinkingPreview('正在检查直播间投递链路。'), true);
  assert.equal(isUsefulLiveRoomThinkingPreview('x'.repeat(80)), true);

  // Test adding system events
  tracker.onSystemEvent('开始处理消息 | codex (local_acpx)', '🚀');
  tracker.onSystemEvent('思考分析：读取 /srv/agent-platform/src/config.ts token=secret-value', '🧠');
  assert.match((tracker as any).buildCard().elements[0].content, /当前阶段：思考/);
  assert.match((tracker as any).buildCard().elements[0].content, /最新进展：.*思考分析：读取 src\/config\.ts/);
  tracker.onSystemEvent('心跳保活：当前步骤耗时较长，持续处理中...', '💓');
  assert.match((tracker as any).buildCard().elements[0].content, /当前阶段：思考/);
  assert.match((tracker as any).buildCard().elements[0].content, /最新进展：.*思考分析/);
  assert.doesNotMatch(JSON.stringify((tracker as any).buildCard()), /心跳保活/);
  await (tracker as any).flushPromise;
  const flushCountBeforeDuplicateHeartbeat = flushCount;
  tracker.onSystemEvent('心跳保活：当前步骤耗时较长，持续处理中...', '💓');
  await (tracker as any).flushPromise;
  assert.equal(flushCount, flushCountBeforeDuplicateHeartbeat + 1);

  // Test adding tool events
  tracker.onToolEvent('view_file', 'src/lib/feishu-progress.ts', '📄');
  tracker.onToolEvent('view_file', 'src/lib/feishu-progress.ts', '📄');
  tracker.onToolEvent('run_command', 'npx tsc --noEmit --token sk-secret123', '⚡');
  for (let index = 0; index < 5; index += 1) tracker.onToolEvent(`tool-${index}`, `/tmp/private-${index}.txt`, '🛠️');
  tracker.onSystemEvent('心跳保活：当前步骤耗时较长，持续处理中...', '💓');
  now += 65_000;

  // Inspect internal card structure via buildCard (private method)
  const card = (tracker as any).buildCard();

  assert.strictEqual(card.config.wide_screen_mode, true);
  assert.strictEqual(card.header.title.content, '🔄 Agent 执行中...');
  assert.match(card.elements[0].content, /当前阶段：工具.*已用时 1分5秒.*累计 8 步/);
  assert.match(card.elements[0].content, /最新进展：.*tool-4：private-4\.txt/);

  const systemPanel = card.elements.find((el: any) =>
    el.tag === 'collapsible_panel' && el.header?.title?.content === '⚙️ 系统信息详情'
  );
  assert.ok(systemPanel, 'System info collapsible panel should exist');
  assert.strictEqual(systemPanel.elements.length, 2, 'Heartbeats should not appear in system logs');
  assert.ok(systemPanel.elements[0].content.includes('🚀'), 'First log should have start emoji');
  assert.ok(systemPanel.elements[0].content.includes('开始处理消息'), 'First log content check');
  assert.ok(systemPanel.elements[1].content.includes('🧠'), 'Second log should have thinking emoji');
  assert.doesNotMatch(systemPanel.elements[1].content, /\/srv\/|secret-value/);
  assert.doesNotMatch(JSON.stringify(systemPanel), /心跳保活|💓/);

  const toolPanel = card.elements.find((el: any) =>
    el.tag === 'collapsible_panel' && el.header?.title?.content === '🛠️ 最近 5 条工具'
  );
  assert.ok(toolPanel, 'Tool details collapsible panel should exist');
  assert.strictEqual(toolPanel.elements.length, 5, 'Should show only the 5 most recent tool lines');
  assert.doesNotMatch(JSON.stringify(card), /sk-secret123|\/tmp\//);

  const finalCard = (tracker as any).buildFinalCard(
    'failed at /srv/agent-platform/private.ts token=secret-value',
    false,
  );
  assert.strictEqual(finalCard.header.title.content, '❌ 执行失败');
  assert.match(finalCard.elements[0].content, /摘要：[\s\S]*private\.ts[\s\S]*工具 tally：[\s\S]*view_file ×2[\s\S]*tool-4 ×1/);
  assert.doesNotMatch(JSON.stringify(finalCard), /\/srv\/|secret-value|sk-secret123|\/tmp\//);
  assert.strictEqual((tracker as any).buildFinalCard('done', true).header.title.content, '✅ 执行完成');
  Date.now = originalNow;

  console.log('✅ FeishuProgressTracker system info tests passed cleanly!');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
