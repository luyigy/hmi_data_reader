import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto('file://' + path.join(directory, 's05-step2-lock-order.html'));
  assert.equal(await page.locator('tbody tr').count(), 9);
  const records = page.locator('details.raw');
  for (let i = 0; i < await records.count(); i++) {
    const record = records.nth(i);
    const name = await record.locator('summary').textContent();
    assert.equal(await record.locator('pre').textContent(), fs.readFileSync(path.join(directory, name), 'utf8'));
    await record.locator('summary').click(); assert(await record.locator('pre').isVisible());
    await record.locator('summary').click();
  }
  for (const width of [1440, 390]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  const result = { passed: true, rows: 9, exactRawRecords: await records.count(), mobileAndDesktop: true, lightAndDark: true, errors, externalRequests: requests };
  fs.writeFileSync(path.join(directory, 'html-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
