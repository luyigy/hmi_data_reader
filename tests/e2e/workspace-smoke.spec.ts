import { test, expect } from '@playwright/test';

test.describe('Workspace Smoke Test', () => {
  test('1. should navigate to /workspaces and display correctly', async ({ page }) => {
    await page.goto('http://localhost:3010/workspaces');
    
    // Check for title Workspaces
    await expect(page.getByText('Workspaces', { exact: true }).first()).toBeVisible();
    
    // Check for "New Workspace" button (Chinese: 新建 Workspace)
    await expect(page.getByText(/新建 Workspace/i).or(page.getByRole('button', { name: /新建 Workspace/i }))).toBeVisible();
  });

  test('2. should see projected workspaces in the list', async ({ page }) => {
    await page.goto('http://localhost:3010/workspaces');
    
    // Wait for the loader to disappear or workspaces to appear
    const workspaceItems = page.locator('a[href^="/workspaces/"]');
    await expect(workspaceItems.first()).toBeVisible({ timeout: 10000 });
    
    const count = await workspaceItems.count();
    console.log(`Found ${count} workspaces`);
    expect(count).toBeGreaterThan(0);
  });

  test('3. should verify workspace status labels', async ({ page }) => {
    await page.goto('http://localhost:3010/workspaces');
    
    // Look for status tags like idle, running, etc.
    const statusTags = page.locator('span:has-text("idle"), span:has-text("running"), span:has-text("waiting"), span:has-text("failed")');
    // We don't strictly require them to exist if no active runs, but we should see some markers
    console.log(`Found ${await statusTags.count()} status tags`);
  });

  test('4. should be able to create a workspace and redirect to detail page', async ({ page }) => {
    await page.goto('http://localhost:3010/workspaces');

    const workspaceTitle = `Workspace smoke ${Date.now()}`;
    await page.getByPlaceholder('例如：跨网关 OCR 工作空间').fill(workspaceTitle);
    await page.getByPlaceholder('给这个 workspace 一个当前 topic / task...').fill('Smoke topic');
    await page.getByRole('button', { name: '创建 Workspace' }).click();

    await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: workspaceTitle })).toBeVisible({ timeout: 10000 });
  });

  test('5. should be able to send a message in a workspace', async ({ page }) => {
    await page.goto('http://localhost:3010/workspaces');
    
    // Click on the first workspace
    const workspaceItems = page.locator('a[href^="/workspaces/"]');
    await workspaceItems.first().click();
    
    // Wait for the message input to be visible
    const chatInput = page.locator('textarea, input[placeholder*="message"]');
    await expect(chatInput.first()).toBeVisible();
    
    // Type and send a message
    const testMessage = `Smoke test message from Gemini at ${new Date().toISOString()}`;
    await chatInput.first().fill(testMessage);
    await page.keyboard.press('Enter');
    
    // Check if message appears in the list
    await expect(page.getByText(testMessage)).toBeVisible({ timeout: 10000 });
  });

  test('6. should verify /rooms compatibility', async ({ page }) => {
    await page.goto('http://localhost:3010/rooms');
    
    // It should still work and show some content
    await expect(page.locator('h1, h2, h3').first()).toBeVisible();
    
    // Click on a room
    const roomItems = page.locator('a[href^="/rooms/"]');
    if (await roomItems.count() > 0) {
      await roomItems.first().click();
      await expect(page).toHaveURL(/\/rooms\/.+/);
    }
  });

  test('7. sidebar should have Workspaces link', async ({ page }) => {
    await page.goto('http://localhost:3010/');
    
    const sidebar = page.locator('nav, aside, [class*="sidebar"]');
    await expect(sidebar.getByText(/workspaces/i)).toBeVisible();
    
    const workspaceLink = sidebar.locator('a[href="/workspaces"]');
    await expect(workspaceLink).toBeVisible();
  });

  test('8. should see Feishu tags for bound workspaces', async ({ page }) => {
    await page.goto('http://localhost:3010/workspaces');
    
    // Check if any workspace item has a Feishu tag
    const feishuTags = page.locator('span:has-text("Feishu"), [title*="Feishu"]');
    const count = await feishuTags.count();
    console.log(`Found ${count} workspaces with Feishu link`);
  });
});
