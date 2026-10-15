import assert from 'node:assert/strict';
import { getFeishuUserDisplayName } from '../src/lib/feishu-api';

process.env.FEISHU_APP_ID = 'cli_test';
process.env.FEISHU_APP_SECRET = 'test_secret';

const originalFetch = global.fetch;
const requests: string[] = [];
let basicAllowed = true;
global.fetch = async (input) => {
  const url = String(input);
  requests.push(url);
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    return Response.json({ code: 0, tenant_access_token: 'test_token', expire: 3600 });
  }
  if (url.includes('/contact/v3/users/basic_batch')) {
    return Response.json(basicAllowed
      ? { code: 0, data: { users: [{ user_id: 'ou_test', name: 'English', i18n_name: { zh_cn: '中文姓名' } }] } }
      : { code: 99991672, msg: 'missing basic profile scope' }, { status: basicAllowed ? 200 : 400 });
  }
  if (url.includes('/contact/v3/users/ou_test')) {
    return Response.json({ code: 0, data: { user: { name: '备用姓名' } } });
  }
  throw new Error(`Unexpected request: ${url}`);
};

void (async () => {
  try {
    assert.equal(await getFeishuUserDisplayName('ou_test'), '中文姓名');
    assert.ok(requests.some((url) => url.includes('basic_batch?user_id_type=open_id')));
    assert.ok(!requests.some((url) => url.includes('/users/ou_test')));
    basicAllowed = false;
    assert.equal(await getFeishuUserDisplayName('ou_test'), '备用姓名');
  } finally {
    global.fetch = originalFetch;
  }
})();
