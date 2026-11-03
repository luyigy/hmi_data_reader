import assert from 'node:assert/strict';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';
import { buildAssistantRelayCard } from '../src/lib/feishu-live-room-relay';
import { buildRunReplyCard } from '../src/lib/task-run-reply-card';
import { safeFeishuCard } from '../src/lib/feishu-card-markdown';
import type { LiveRoomMessagePayload } from '../src/lib/live-room-types';

const table = '| 部分 | 作用 | 之前沙箱里的情况 |\n|---|---|---|\n| CLI 程序及其安装目录 | 执行命令 | 有入口，但软链接目标可能不可见，转而使用另一版本 |\n| `config.json` | 确定应用、账号等配置 | 项目里有一份 |\n| 加密凭据目录及解密密钥 | 真正完成认证 | 没挂载进去 |';
const content = `说明\n\n${table}\n\n代码示例保持原样：\n\`\`\`markdown\n${table}\n\`\`\``;
const tracker = new FeishuProgressTracker('fixture') as unknown as {
  buildFinalCard(text: string, success: boolean): Record<string, unknown>;
};
const cards = [
  tracker.buildFinalCard(content, true),
  buildAssistantRelayCard({ content, senderName: 'codex', metadata: { footnotes: ['模型：fixture'] } } as unknown as LiveRoomMessagePayload),
  buildRunReplyCard({ id: 'fixture', status: 'completed', summary: content, error: null, participants: [] }, []),
];
for (const raw of cards) {
  const card = safeFeishuCard(raw);
  assert.equal(card.schema, '2.0', 'Markdown tables require Card JSON 2.0 on every reply route');
  assert.equal(card.elements, undefined);
  const body = card.body as { elements: Array<{ tag: string; content?: string }> };
  assert.equal(body.elements.find(element => element.tag === 'markdown')?.content, content);
  assert.doesNotMatch(JSON.stringify(card), /"tag":"note"/, 'Legacy notes must not invalidate v2 replies');
  assert.deepEqual(safeFeishuCard(card), card, 'Retries must retain the exact same rendered payload');
}
console.log('Reply markdown: user table and fenced examples retained in v2 progress, relay and task cards');
