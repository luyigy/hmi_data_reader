import { chromium } from '@playwright/test';
import fs from 'fs';

// Read .env
const env = {};
if (fs.existsSync('.env')) {
  fs.readFileSync('.env', 'utf-8').split('\n').forEach(l => {
    if (l.includes('=') && !l.trim().startsWith('#')) {
      const [k, ...v] = l.split('=');
      env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
    }
  });
}

const adminUsername = env.AUTH_ADMIN_USERNAME || 'admin';
const adminPassword = env.AUTH_ADMIN_PASSWORD || 'admin123456';

async function takeScreenshots() {
  if (!fs.existsSync('docs/screenshots')) {
    fs.mkdirSync('docs/screenshots', { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });

  const page = await context.newPage();

  console.log(`Logging in with user: ${adminUsername}...`);
  await page.goto('http://127.0.0.1:3010/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Fill login
  await page.fill('input[placeholder="输入用户名"]', adminUsername);
  await page.fill('input[placeholder="输入密码"]', adminPassword);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  console.log('Current URL after login:', page.url());

  const pagesToCapture = [
    { url: 'http://127.0.0.1:3010/', name: 'dashboard' },
    { url: 'http://127.0.0.1:3010/workspaces', name: 'workspaces' },
    { url: 'http://127.0.0.1:3010/chat', name: 'chat' },
    { url: 'http://127.0.0.1:3010/rooms', name: 'rooms' },
    { url: 'http://127.0.0.1:3010/workflow', name: 'workflow' },
    { url: 'http://127.0.0.1:3010/gateway-tools', name: 'gateway-tools' },
    { url: 'http://127.0.0.1:3010/tasks', name: 'tasks' },
  ];

  for (const item of pagesToCapture) {
    try {
      console.log(`Capturing ${item.name} (${item.url})...`);
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const outPath = `docs/screenshots/${item.name}.png`;
      await page.screenshot({ path: outPath, fullPage: false });
      console.log(`✅ Saved ${outPath}`);
    } catch (e) {
      console.warn(`❌ Failed capturing ${item.name}:`, e.message);
    }
  }

  // Also capture a 16:9 banner resolution specifically crafted for covers
  try {
    const coverContext = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 2
    });
    const coverPage = await coverContext.newPage();
    // Re-use session cookie or login
    await coverPage.goto('http://127.0.0.1:3010/login', { waitUntil: 'domcontentloaded' });
    await coverPage.fill('input[placeholder="输入用户名"]', adminUsername);
    await coverPage.fill('input[placeholder="输入密码"]', adminPassword);
    await coverPage.click('button[type="submit"]');
    await coverPage.waitForTimeout(2000);

    // Dashboard Cover
    await coverPage.goto('http://127.0.0.1:3010/', { waitUntil: 'domcontentloaded' });
    await coverPage.waitForTimeout(2000);
    await coverPage.screenshot({ path: 'docs/screenshots/platform_cover_dashboard.png' });
    console.log('✅ Saved docs/screenshots/platform_cover_dashboard.png');

    // Workspaces Cover
    await coverPage.goto('http://127.0.0.1:3010/workspaces', { waitUntil: 'domcontentloaded' });
    await coverPage.waitForTimeout(2000);
    await coverPage.screenshot({ path: 'docs/screenshots/platform_cover_workspaces.png' });
    console.log('✅ Saved docs/screenshots/platform_cover_workspaces.png');

    await coverContext.close();
  } catch (err) {
    console.warn('Cover screenshot warning:', err.message);
  }

  await browser.close();
  console.log('All screenshots completed!');
}

takeScreenshots().catch(console.error);
