import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearKimiCodeQuotaCacheForTests,
  getKimiCodeAccountQuota,
  parseKimiCodeQuotaPayload,
} from '../src/lib/real-agents/kimi-code-telemetry';

const now = new Date('2026-07-30T10:00:00.000Z');
const payload = {
  usage: {
    used: '40',
    limit: '1000',
    resetTime: '2026-08-03T05:20:51.000Z',
  },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { used: '1', limit: '100', resetTime: '2026-07-30T15:00:00.000Z' },
  }],
  boosterWallet: {
    id: 'private-wallet',
    balance: { amount: '999999999' },
  },
  account: { email: 'private@example.com' },
};

assert.deepEqual(parseKimiCodeQuotaPayload(payload), {
  summary: {
    used: 40,
    limit: 1000,
    resetAt: '2026-08-03T05:20:51.000Z',
    window: { duration: 1, unit: 'week' },
  },
  limits: [{
    used: 1,
    limit: 100,
    resetAt: '2026-07-30T15:00:00.000Z',
    window: { duration: 5, unit: 'hour' },
  }],
});
assert.equal(parseKimiCodeQuotaPayload({ usage: { used: 'bad', limit: 10 } }), null);
assert.equal(parseKimiCodeQuotaPayload(null), null);

const config = (provider = 'managed:kimi-code') => `
default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "${provider}"
`;

const main = async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-quota-'));
  const credentials = path.join(home, 'credentials');
  const originalBaseUrl = process.env.KIMI_CODE_BASE_URL;
  delete process.env.KIMI_CODE_BASE_URL;
  await mkdir(credentials);
  await writeFile(path.join(home, 'config.toml'), config());
  const writeCredential = (accessToken: string, expiresAt: number) =>
    writeFile(path.join(credentials, 'kimi-code.json'), JSON.stringify({
      access_token: accessToken,
      refresh_token: 'not-read-by-quota',
      expires_at: expiresAt,
    }));

  try {
    await writeCredential('token-a', now.getTime() / 1000 + 600);
    clearKimiCodeQuotaCacheForTests();
    let fetchCount = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(String(url), 'https://api.kimi.com/coding/v1/usages');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer token-a');
      assert.equal(headers.get('accept'), 'application/json');
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    const [first, concurrent] = await Promise.all([
      getKimiCodeAccountQuota({ home, now, fetchImpl }),
      getKimiCodeAccountQuota({ home, now, fetchImpl }),
    ]);
    assert.deepEqual(concurrent, first);
    assert.equal(first.status, 'available');
    assert.equal(fetchCount, 1);
    assert.doesNotMatch(JSON.stringify(first), /wallet|email|token|credential|account/i);

    const cached = await getKimiCodeAccountQuota({
      home,
      now: new Date(now.getTime() + 4 * 60 * 1000),
      fetchImpl: (async () => {
        throw new Error('cache miss');
      }) as typeof fetch,
    });
    assert.deepEqual(cached, first);

    const refreshedAt = new Date(now.getTime() + 5 * 60 * 1000 + 1);
    const refreshed = await getKimiCodeAccountQuota({
      home,
      now: refreshedAt,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ usage: { used: 3, limit: 10 } }), {
          status: 200,
        })) as typeof fetch,
    });
    assert.equal(refreshed.status === 'available' ? refreshed.summary?.used : null, 3);
    await getKimiCodeAccountQuota({
      home,
      now: new Date(now.getTime() - 2 * 60 * 1000),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ usage: { used: 99, limit: 100 } }), {
          status: 200,
        })) as typeof fetch,
    });
    const afterOutOfOrder = await getKimiCodeAccountQuota({
      home,
      now: new Date(refreshedAt.getTime() + 1),
      fetchImpl: (async () => {
        throw new Error('newer cache should survive an out-of-order result');
      }) as typeof fetch,
    });
    assert.equal(
      afterOutOfOrder.status === 'available' ? afterOutOfOrder.summary?.used : null,
      3
    );

    await writeCredential('token-b', now.getTime() / 1000 + 600);
    const switched = await getKimiCodeAccountQuota({
      home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ usage: { used: 2, limit: 10 } }), {
          status: 200,
        })) as typeof fetch,
    });
    assert.equal(switched.status === 'available' ? switched.summary?.used : null, 2);

    clearKimiCodeQuotaCacheForTests();
    assert.deepEqual(await getKimiCodeAccountQuota({
      home,
      now,
      fetchImpl: (async () => {
        throw new Error('quota unavailable');
      }) as typeof fetch,
    }), { status: 'unknown' });

    assert.deepEqual(await getKimiCodeAccountQuota({
      home,
      now,
      timeoutMs: 1,
      fetchImpl: ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch,
    }), { status: 'unknown' });

    await writeCredential('expired', now.getTime() / 1000 - 1);
    assert.deepEqual(await getKimiCodeAccountQuota({
      home,
      now,
      fetchImpl: (async () => {
        throw new Error('expired credentials must not fetch');
      }) as typeof fetch,
    }), { status: 'unknown' });

    await writeFile(path.join(home, 'config.toml'), config('custom-provider'));
    await writeCredential('token-c', now.getTime() / 1000 + 600);
    assert.deepEqual(await getKimiCodeAccountQuota({
      home,
      now,
      fetchImpl: (async () => {
        throw new Error('non-managed provider must not fetch');
      }) as typeof fetch,
    }), { status: 'unknown' });
  } finally {
    clearKimiCodeQuotaCacheForTests();
    if (originalBaseUrl === undefined) delete process.env.KIMI_CODE_BASE_URL;
    else process.env.KIMI_CODE_BASE_URL = originalBaseUrl;
    await rm(home, { recursive: true, force: true });
  }

  console.log('kimi code quota tests passed');
};

void main();
