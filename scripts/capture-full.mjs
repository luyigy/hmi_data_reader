import { chromium } from '@playwright/test';
import fs from 'fs';

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

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });

  const page = await context.newPage();

  // Login
  console.log('Logging in...');
  await page.goto('http://127.0.0.1:3010/login');
  await page.fill('input[placeholder="输入用户名"]', adminUsername);
  await page.fill('input[placeholder="输入密码"]', adminPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL('http://127.0.0.1:3010/');

  // Wait for data to load
  await page.waitForSelector('text=antigravity', { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Take full dashboard screenshot
  await page.screenshot({ path: 'docs/screenshots/dashboard_full.png', fullPage: false });
  console.log('Saved docs/screenshots/dashboard_full.png');

  // Also take high-res 16:9 banner cover
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'docs/screenshots/platform_cover.png', fullPage: false });
  console.log('Saved docs/screenshots/platform_cover.png');

  // Take Chat Room
  console.log('Navigating to chat...');
  await page.goto('http://127.0.0.1:3010/chat');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/chat_full.png', fullPage: false });
  console.log('Saved docs/screenshots/chat_full.png');

  // Take Gateway tools
  console.log('Navigating to gateway-tools...');
  await page.goto('http://127.0.0.1:3010/gateway-tools');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/gateway_tools_full.png', fullPage: false });
  console.log('Saved docs/screenshots/gateway_tools_full.png');

  // Take Workspaces
  console.log('Navigating to workspaces...');
  await page.goto('http://127.0.0.1:3010/workspaces');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/workspaces_full.png', fullPage: false });
  console.log('Saved docs/screenshots/workspaces_full.png');

  await browser.close();
  console.log('All done!');
}

run().catch(console.error);
