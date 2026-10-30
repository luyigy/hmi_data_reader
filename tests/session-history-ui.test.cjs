// Isolated Next server and mocked inventory/actions: never submit a real cleanup.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
(async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'ap-history-ui-'));
  const baseURL = 'http://127.0.0.1:3219';
  const env = { ...process.env, AUTH_ADMIN_USERNAME: 'history-ui-test', AUTH_ADMIN_PASSWORD: randomBytes(24).toString('hex'), AUTH_SESSION_SECRET: randomBytes(32).toString('hex'), AUTH_ALLOW_INSECURE_LOCAL: 'false', AP_SESSION_HISTORY_STATE_ROOT: stateRoot };
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3219'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  const stopped = once(server, 'exit');
  let browser;
  try {
    await expect.poll(() => { if (server.exitCode !== null) throw new Error(output); return output.includes('Ready'); }, { timeout: 30000 }).toBe(true);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL });
    assert.equal((await context.request.get('/api/admin/session-history?status=1')).status(), 401);
    const login = await context.request.post('/api/auth/login', { data: { username: env.AUTH_ADMIN_USERNAME, password: env.AUTH_ADMIN_PASSWORD } });
    assert.equal(login.status(), 200);
    await context.addCookies((await context.cookies()).map(cookie => ({ ...cookie, secure: false })));
    const actual = await context.request.get('/api/admin/session-history?status=1');
    assert.equal(actual.status(), 200); assert.equal((await actual.json()).enabled, false);
    const page = await context.newPage();
    await page.clock.install();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const now = Date.now();
    const row = { key: 'a'.repeat(64), nativeId: 'fixture-only', harness: 'codex', bytes: 1024, state: 'eligible', fileCount: 1, lastActivity: now - 40 * 86400000, location: '/fixture', references: [], reasons: [] };
    const listing = { rows: [row], sampledAt: now, truncated: false, sources: [], unsupported: [], cleanup: { enabled: false, reason: 'stale listing value' }, total: 1, page: 0, summary: { count: 1, bytes: 1024, eligible: 1, eligibleBytes: 1024, unknown: 0 } };
    const receipt = { id: 'fixture-preview', state: 'preview', expiresAt: now + 600000, bytes: 1024, deletedBytes: 0, items: [{ row, status: 'pending' }], excluded: [] };
    let status = { enabled: false, reason: '等待任务空闲后自动启用清理：1 个未结束任务。' }, statusCode = 200, confirmations = 0, inventories = 0;
    await page.route('**/api/admin/session-history*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body.action === 'confirm') { confirmations++; assert.equal(body.confirmPermanent, true); assert.equal(body.operationId, receipt.id); }
        return route.fulfill({ json: body.action === 'confirm' ? { ...receipt, state: 'completed', deletedBytes: 1024 } : receipt });
      }
      if (url.searchParams.get('status') === '1') return route.fulfill({ status: statusCode, json: status });
      inventories++; return route.fulfill({ json: listing });
    });
    await page.goto('/admin/session-history');
    await page.getByRole('button', { name: '选择本页可清理项' }).click();
    await page.getByRole('button', { name: /^预览清理/ }).click();
    await page.getByLabel('我已核对清单').check();
    const confirm = page.getByRole('button', { name: '确认永久清理', exact: true });
    await expect(confirm).toBeDisabled();
    await expect(page.locator('#cleanup-confirmation-reason')).toContainText('等待任务空闲');
    const originalInventories = inventories;
    status = { enabled: true };
    await page.clock.runFor(5100);
    await expect(confirm).toBeEnabled();
    assert.equal(inventories, originalInventories, 'polling does not rescan inventory or clear selection');
    await expect(page.getByLabel('我已核对清单')).toBeChecked();
    statusCode = 503;
    await page.clock.runFor(5100);
    await expect(confirm).toBeDisabled();
    await expect(page.locator('#cleanup-confirmation-reason')).toContainText('正在自动重试');
    statusCode = 200;
    await page.clock.runFor(5100);
    await expect(confirm).toBeEnabled();
    await confirm.click(); // Intercepted above; no real history action reaches the server.
    await expect(page.getByRole('heading', { name: '清理回执 · 已完成' })).toBeVisible();
    assert.equal(confirmations, 1);
    await page.getByRole('button', { name: '选择本页可清理项' }).click();
    await page.getByRole('button', { name: /^预览清理/ }).click();
    await page.getByLabel('我已核对清单').check();
    await page.clock.fastForward(601000);
    await expect(confirm).toBeDisabled();
    await expect(page.locator('#cleanup-confirmation-reason')).toContainText('预览已过期');
    assert.deepEqual(errors, []);
    console.log('Browser: authenticated status endpoint, checkbox/disabled reason, live activation without rescan, temporary outage/recovery, mocked confirmation and expiry passed. Real history untouched.');
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill('SIGTERM'); await stopped; }
    rmSync(stateRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
