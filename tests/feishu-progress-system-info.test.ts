import assert from 'node:assert';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';

async function runTest() {
  console.log('[Test] Testing FeishuProgressTracker system info collapsible panel...');

  const tracker = new FeishuProgressTracker('test-chat-123');

  // Test adding system events
  tracker.onSystemEvent('开始处理消息 | codex (local_acpx)', '🚀');
  tracker.onSystemEvent('思考分析：正在检查仓库配置文件...', '🧠');
  tracker.onSystemEvent('心跳保活：当前步骤耗时较长，持续处理中...', '💓');

  // Test adding tool events
  tracker.onToolEvent('view_file', 'src/lib/feishu-progress.ts', '📄');
  tracker.onToolEvent('run_command', 'npx tsc --noEmit', '⚡');

  // Inspect internal card structure via buildCard (private method)
  const card = (tracker as any).buildCard();

  assert.strictEqual(card.config.wide_screen_mode, true);
  assert.strictEqual(card.header.title.content, '🔄 Agent 执行中...');

  const systemPanel = card.elements.find((el: any) =>
    el.tag === 'collapsible_panel' && el.header?.title?.content === '⚙️ 系统信息详情'
  );
  assert.ok(systemPanel, 'System info collapsible panel should exist');
  assert.strictEqual(systemPanel.elements.length, 3, 'Should have 3 system log lines');
  assert.ok(systemPanel.elements[0].content.includes('🚀'), 'First log should have start emoji');
  assert.ok(systemPanel.elements[0].content.includes('开始处理消息'), 'First log content check');
  assert.ok(systemPanel.elements[1].content.includes('🧠'), 'Second log should have thinking emoji');
  assert.ok(systemPanel.elements[2].content.includes('💓'), 'Third log should have heartbeat emoji');

  const toolPanel = card.elements.find((el: any) =>
    el.tag === 'collapsible_panel' && el.header?.title?.content === '🛠️ 工具调用详情'
  );
  assert.ok(toolPanel, 'Tool details collapsible panel should exist');
  assert.strictEqual(toolPanel.elements.length, 2, 'Should have 2 tool call lines');

  console.log('✅ FeishuProgressTracker system info tests passed cleanly!');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
