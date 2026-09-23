import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveFeishuMessageTarget, sendFeishuTextMessage, sendFeishuInteractiveMessage, sendFeishuLocalImageMessage } from '../src/lib/feishu-api';
import { FeishuProgressTracker } from '../src/lib/feishu-progress';

async function main() {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(path.join(process.cwd(), '.feishu-thread-output-'));
  const filePath = path.join(directory, 'test.png');
  const requests: Array<{ url: URL; body: Record<string, any> }> = [];
  let rejectReply = false;
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  await writeFile(filePath, new Uint8Array([137, 80, 78, 71]));
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 3600 });
    if (url.pathname.endsWith('/images')) return Response.json({ code: 0, data: { image_key: 'img_test' } });
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    if (init?.method === 'PATCH') return Response.json({ code: 230001, msg: 'edit rejected' });
    if (url.pathname.endsWith('/reply')) {
      assert.equal(url.pathname, '/open-apis/im/v1/messages/root-A/reply');
      assert.equal(url.search, '');
      assert.equal(body.reply_in_thread, true);
      assert.equal(body.receive_id, undefined);
      if (rejectReply) return Response.json({ code: 230001, msg: 'reply rejected' }, { status: 400 });
    } else {
      assert.equal(url.pathname, '/open-apis/im/v1/messages');
      assert.equal(url.searchParams.get('receive_id_type'), 'chat_id', 'create API cannot accept thread_id');
      assert.equal(body.receive_id, 'legacy-chat');
    }
    return Response.json({ code: 0, data: { message_id: `om-${requests.length}` } });
  }) as typeof fetch;
  try {
    const target = resolveFeishuMessageTarget({ chatId: 'group', threadId: 'thread-A', rootMessageId: 'root-A' });
    assert.throws(() => resolveFeishuMessageTarget({ chatId: 'group', threadId: 'thread-A' }), /missing its root/);
    await sendFeishuTextMessage({ ...target, text: 'private text' });
    await sendFeishuInteractiveMessage({ ...target, card: { elements: [] }, uuid: 'unique-card' });
    assert.equal(requests.at(-1)!.body.uuid, 'unique-card');
    await sendFeishuLocalImageMessage({ ...target, filePath });
    assert.deepEqual(requests.map(r => r.body.msg_type), ['text', 'interactive', 'image']);
    assert.deepEqual(JSON.parse(requests[2].body.content), { image_key: 'img_test' });
    const tracker = new FeishuProgressTracker({ chatId: 'group', threadId: 'thread-A', rootMessageId: 'root-A' });
    tracker.onSystemEvent('progress');
    await tracker.flush();
    const beforeFinal = requests.length;
    await tracker.finalize('done', true);
    assert.equal(requests.length, beforeFinal + 2, 'API error on final PATCH must trigger a reply retry');
    assert.ok(requests.at(-1)!.url.pathname.endsWith('/root-A/reply'));
    rejectReply = true;
    const beforeFailure = requests.length;
    await assert.rejects(sendFeishuTextMessage({ ...target, text: 'private' }), /reply rejected/);
    await assert.rejects(sendFeishuInteractiveMessage({ ...target, card: {} }), /reply rejected/);
    await assert.rejects(sendFeishuLocalImageMessage({ ...target, filePath }), /reply rejected/);
    assert.equal(requests.length, beforeFailure + 3, 'no create fallback after reply rejection');
    await sendFeishuTextMessage({ receiveId: 'legacy-chat', text: 'legacy' });
    await sendFeishuInteractiveMessage({ receiveId: 'legacy-chat', card: {} });
    await sendFeishuLocalImageMessage({ receiveId: 'legacy-chat', filePath });
    console.log('Feishu thread HTTP contract: text/card/image/progress/retry/fail-closed/legacy passed');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
