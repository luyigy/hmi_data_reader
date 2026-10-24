const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory.json'), 'utf8'));
  const assessment = JSON.parse(fs.readFileSync(path.join(__dirname, 'assessment.json'), 'utf8'));
  const rows = [...data.transactions, ...data.helpers];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], remoteRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.goto('file://' + path.join(__dirname, 's05-step1-boundary-inventory.html'));
    assert.equal(await page.locator('.entry').count(), rows.length);
    assert.equal(await page.locator('.finding').count(), assessment.findings.length);
    for (let i = 0; i < rows.length; i++) {
      const expected = rows[i].source.split('\n').map((line, n) => `${String(rows[i].line + n).padStart(4)}  ${line}`).join('\n');
      assert.equal(await page.locator('.entry').nth(i).locator('code').textContent(), expected);
    }
    await page.locator('#search').fill('restart-recovery');
    assert.equal(await page.locator('.entry:not([hidden])').count(), 5);
    await page.locator('#reset').click();
    await page.locator('#status').selectOption('边界待审');
    const expectedFiltered = Object.values(assessment.entries).filter(e => e.status === '边界待审').length;
    assert.equal(await page.locator('.entry:not([hidden])').count(), expectedFiltered);
    await page.locator('#finding-L1 .refs a').first().click();
    assert.equal(await page.locator('.entry:not([hidden])').count(), rows.length);
    const target = page.locator('.entry:target');
    await target.locator('summary').click();
    assert(await target.locator('pre').isVisible());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.emulateMedia({ colorScheme: 'light' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    const result = { passed: true, entries: rows.length, findings: assessment.findings.length,
      sourceText: 'all exact', search: 'pass', statusFilter: 'pass', sourceJumpAndExpand: 'pass',
      mobileLightAndDarkNoOverflow: true, remoteRequests: 0, javascriptErrors: 0,
      limitation: 'Artifact usability and source rendering only, not runtime repair acceptance' };
    fs.writeFileSync(path.join(__dirname, 'html-verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
