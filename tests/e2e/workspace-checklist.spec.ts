import { test, expect } from '@playwright/test';

test.describe('Workspace Complete Checklist Test', () => {
  const BASE_URL = 'http://localhost:3010';

  test('1. should navigate to /workspaces and display correctly', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspaces`);
    
    // Check for title Workspaces
    await expect(page.getByText('Workspaces', { exact: true }).first()).toBeVisible({ timeout: 15000 });
    
    // Check for "项目工作空间" title
    await expect(page.getByText('项目工作空间')).toBeVisible();
    
    // Check for "新建 Workspace" header
    await expect(page.getByText('新建 Workspace')).toBeVisible();
  });

  test('2. should see projected workspaces with details', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspaces`);
    
    // Wait for workspaces to load
    const workspaceItems = page.locator('a[href^="/workspaces/"]');
    await expect(workspaceItems.first()).toBeVisible({ timeout: 15000 });
    
    const count = await workspaceItems.count();
    console.log(`Found ${count} workspaces`);
    expect(count).toBeGreaterThan(0);
    
    // Check for details in the first item: topic, member count, speaker
    const firstItem = workspaceItems.first();
    await expect(firstItem.locator('div.text-slate-500').first()).toBeVisible();
    await expect(firstItem.getByText(/members/).first()).toBeVisible();
  });

  test('3. should verify status and attention labels', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspaces`);
    await expect(page.locator('a[href^="/workspaces/"]').first()).toBeVisible({ timeout: 15000 });

    const statusMarkers = ['idle', 'running', 'waiting', 'failed', 'archived', 'needs you', 'updates'];
    let foundMarkers = [];
    for (const marker of statusMarkers) {
      const locator = page.locator(`span:has-text("${marker}")`).first();
      if (await locator.isVisible()) {
        foundMarkers.push(marker);
      }
    }
    console.log(`Found markers: ${foundMarkers.join(', ') || 'none'}`);
    expect(foundMarkers.length).toBeGreaterThan(0);
  });

  test('4. should create a new workspace', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspaces`);
    await expect(page.getByText('新建 Workspace')).toBeVisible();
    
    const newName = `Test Workspace ${Date.now()}`;
    const newTopic = `Test Topic ${Date.now()}`;
    
    // Fill name using getByPlaceholder
    await page.getByPlaceholder('例如：跨网关 OCR 工作空间').fill(newName);
    // Fill topic using getByPlaceholder
    await page.getByPlaceholder('给这个 workspace 一个当前 topic / task...').fill(newTopic);
    
    // Click create
    await page.getByRole('button', { name: '创建 Workspace' }).click();
    
    // Should auto-jump to /workspaces/{id}
    await expect(page).toHaveURL(new RegExp(`${BASE_URL}/workspaces/cm[a-z0-9]+`), { timeout: 20000 });
    
    // Verify title in the detail view header (h1)
    await expect(page.locator('h1').getByText(newName)).toBeVisible();
    // Verify topic in the right details panel (specifically "topic: ...")
    await expect(page.locator('aside').last().getByText(`topic: ${newTopic}`)).toBeVisible();
    
    // Refresh and check if it still exists in the list
    await page.goto(`${BASE_URL}/workspaces`);
    await expect(page.getByText(newName).first()).toBeVisible({ timeout: 15000 });
  });

  test('5. should verify Feishu tags', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspaces`);
    
    // Wait for load
    await expect(page.locator('a[href^="/workspaces/"]').first()).toBeVisible({ timeout: 15000 });
    
    const feishuTags = page.locator('span:has-text("Feishu")');
    const count = await feishuTags.count();
    console.log(`Found ${count} Feishu tags in the list`);
    
    if (count > 0) {
      await feishuTags.first().click();
      // Look for "Feishu linked" in the right details panel
      await expect(page.locator('aside').last().getByText(/Feishu/i)).toBeVisible({ timeout: 10000 });
    }
  });

  test('6. should verify archiving UI', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspaces`);
    
    // Check for "Archived Workspaces" section
    const archivedHeader = page.getByText('Archived Workspaces');
    await expect(archivedHeader).toBeVisible({ timeout: 15000 });
    
    // Click to expand
    await archivedHeader.click();
    
    const emptyMsg = page.getByText('还没有 archived workspaces');
    if (await emptyMsg.isVisible()) {
      console.log('No archived workspaces yet');
    } else {
      console.log('Found archived workspaces');
    }
  });

  test('7. should verify /rooms compatibility', async ({ page }) => {
    await page.goto(`${BASE_URL}/rooms`);
    await expect(page.getByText('项目工作空间')).toBeVisible({ timeout: 15000 });
    
    const roomItems = page.locator('a[href^="/rooms/"]');
    if (await roomItems.count() > 0) {
      await roomItems.first().click();
      await expect(page).toHaveURL(new RegExp(`${BASE_URL}/rooms/cm[a-z0-9]+`));
    }
  });
});
