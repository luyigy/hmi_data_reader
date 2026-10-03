import assert from 'node:assert/strict';
import { sendFeishuMarkdownFile } from '../src/lib/feishu-api';
import { buildMarkdownPickerCard } from '../src/lib/feishu-markdown-picker';

process.env.FEISHU_APP_ID = 'test-app';
process.env.FEISHU_APP_SECRET = 'test-secret';

const requests: Array<{ url: string; init: RequestInit }> = [];
const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  const url = String(input);
  requests.push({ url, init: init || {} });
  if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
    return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 3600 });
  }
  if (url.endsWith('/im/v1/files')) return Response.json({ code: 0, data: { file_key: 'test-file-key' } });
  return Response.json({ code: 0, data: { message_id: 'reply-id' } });
};

async function main() {
  try {
    const files = [
      ...Array.from({ length: 101 }, (_, index) => `docs/${String(index + 1).padStart(3, '0')}_HANDOVER_测试.md`),
      'docs/102_PLAN_测试.md', 'docs/README.md', 'README.md',
    ];
    const card = buildMarkdownPickerCard({ roomId: 'room', head: 'abc', filter: '', files });
    const form = card.elements.find((element) => element.tag === 'form') as {
      name: string; elements: Array<{ name: string; options?: Array<{ value: string }> }>;
    };
    assert.equal(form.name, 'markdown-picker-handover');
    assert.equal(form.elements[0].options?.length, 100);
    assert.equal(form.elements[0].options?.[0].value, 'docs/101_HANDOVER_测试.md');
    assert.equal(form.elements[0].options?.[99].value, 'docs/002_HANDOVER_测试.md');
    for (const [section, expected] of [
      ['plan', 'docs/102_PLAN_测试.md'], ['docs', 'docs/README.md'], ['other', 'README.md'],
    ]) {
      const view = buildMarkdownPickerCard({ roomId: 'room', head: 'abc', filter: '', files, section });
      const selected = view.elements.find((element) => element.tag === 'form') as typeof form;
      assert.equal(selected.elements[0].options?.[0].value, expected);
    }
    assert(!JSON.stringify(card).includes('上一页'));
    assert(Buffer.byteLength(JSON.stringify(card)) < 30_000);
    const bytes = Buffer.from('# 标题\n原始 **Markdown**\n');
    const messageId = await sendFeishuMarkdownFile({
      chatId: 'chat-id', fileName: '交接.md', content: bytes, replyId: 'card-id',
    });
    assert.equal(messageId, 'reply-id');
    const upload = requests.find(({ url }) => url.endsWith('/im/v1/files'));
    assert(upload?.init.body instanceof FormData);
    assert.equal(upload.init.body.get('file_type'), 'stream');
    assert.equal(upload.init.body.get('file_name'), '交接.md');
    const file = upload.init.body.get('file');
    assert(file instanceof Blob);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    const reply = requests.find(({ url }) => url.endsWith('/im/v1/messages/card-id/reply'));
    assert(reply);
    assert.deepEqual(JSON.parse(String(reply.init.body)), {
      msg_type: 'file', content: JSON.stringify({ file_key: 'test-file-key' }),
    });
  } finally {
    global.fetch = originalFetch;
  }
}

void main();
