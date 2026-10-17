import assert from 'node:assert/strict';
import { buildKimiCodeChildEnv } from '../src/lib/real-agents/kimi-code-agent';

const variables = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'FEISHU_RUNTIME_CODEX_HTTP_PROXY', 'FEISHU_RUNTIME_CODEX_HTTPS_PROXY', 'FEISHU_RUNTIME_CODEX_ALL_PROXY', 'FEISHU_RUNTIME_CODEX_NO_PROXY'] as const;
const original = Object.fromEntries(variables.map((key) => [key, process.env[key]]));

try {
  for (const key of variables) delete process.env[key];
  process.env.FEISHU_RUNTIME_CODEX_HTTP_PROXY = 'http://127.0.0.1:1081';
  process.env.FEISHU_RUNTIME_CODEX_HTTPS_PROXY = 'http://127.0.0.1:1082';
  process.env.FEISHU_RUNTIME_CODEX_ALL_PROXY = 'http://127.0.0.1:1083';
  process.env.FEISHU_RUNTIME_CODEX_NO_PROXY = 'localhost,127.0.0.1';
  const fallback = buildKimiCodeChildEnv();
  assert.equal(fallback.HTTP_PROXY, 'http://127.0.0.1:1081');
  assert.equal(fallback.http_proxy, 'http://127.0.0.1:1081');
  assert.equal(fallback.HTTPS_PROXY, 'http://127.0.0.1:1082');
  assert.equal(fallback.https_proxy, 'http://127.0.0.1:1082');
  assert.equal(fallback.ALL_PROXY, 'http://127.0.0.1:1083');
  assert.equal(fallback.all_proxy, 'http://127.0.0.1:1083');
  assert.equal(fallback.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(fallback.no_proxy, 'localhost,127.0.0.1');

  process.env.HTTP_PROXY = 'http://127.0.0.1:2001';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:2002';
  process.env.ALL_PROXY = 'http://127.0.0.1:2003';
  process.env.NO_PROXY = 'example.test';
  const existing = buildKimiCodeChildEnv();
  assert.equal(existing.HTTP_PROXY, 'http://127.0.0.1:2001');
  assert.equal(existing.HTTPS_PROXY, 'http://127.0.0.1:2002');
  assert.equal(existing.ALL_PROXY, 'http://127.0.0.1:2003');
  assert.equal(existing.NO_PROXY, 'example.test');
  console.log('Kimi Code proxy environment mapping passed');
} finally {
  for (const key of variables) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}
