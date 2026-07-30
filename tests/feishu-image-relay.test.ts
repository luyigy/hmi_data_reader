import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sendFeishuLocalImageMessage } from '../src/lib/feishu-api';

async function main() {
  const directory = await mkdtemp(path.join(process.cwd(), '.feishu-image-relay-'));
  const imagePath = path.join(directory, 'qr.png');
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-secret';

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);

    if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'token', expire: 3600 });
    }
    if (url.endsWith('/im/v1/images')) {
      const form = init?.body as FormData;
      assert.equal(form.get('image_type'), 'message');
      assert.ok(form.get('image') instanceof Blob);
      return Response.json({ code: 0, data: { image_key: 'img_test' } });
    }

    const body = JSON.parse(String(init?.body));
    assert.equal(body.msg_type, 'image');
    assert.deepEqual(JSON.parse(body.content), { image_key: 'img_test' });
    return Response.json({ code: 0, data: { message_id: 'om_test' } });
  }) as typeof fetch;

  try {
    assert.equal(await sendFeishuLocalImageMessage({
      receiveId: 'chat',
      filePath: imagePath,
    }), 'om_test');
    assert.equal(requests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
