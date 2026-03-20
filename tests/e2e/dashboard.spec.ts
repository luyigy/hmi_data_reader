import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display dashboard title', async ({ page }) => {
    await expect(page).toHaveTitle(/Agent Platform/);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  });

  test('should display stats panel', async ({ page }) => {
    // Check for stats cards
    await expect(page.getByText(/total agents/i)).toBeVisible();
    await expect(page.getByText(/online/i)).toBeVisible();
    await expect(page.getByText(/busy/i)).toBeVisible();
    await expect(page.getByText(/offline/i)).toBeVisible();
  });

  test('should display agent grid', async ({ page }) => {
    // Check for agent cards
    const agentCards = page.locator('[data-testid="agent-card"], .agent-card, [class*="agent"]');
    await expect(agentCards.first()).toBeVisible({ timeout: 10000 });
  });

  test('should display agent status colors', async ({ page }) => {
    // Check for status indicators (green=online, yellow=busy, gray=offline)
    const onlineIndicator = page.locator('[class*="green"], [style*="green"], text=online').first();
    await expect(onlineIndicator).toBeVisible({ timeout: 10000 });
  });

  test('should navigate to chat page', async ({ page }) => {
    // Find and click chat navigation
    const chatLink = page.getByRole('link', { name: /chat/i }).first();
    await expect(chatLink).toBeVisible();
    await chatLink.click();
    await expect(page).toHaveURL(/\/chat/);
  });

  test('should navigate to tasks page', async ({ page }) => {
    // Find and click tasks navigation
    const tasksLink = page.getByRole('link', { name: /task/i }).first();
    await expect(tasksLink).toBeVisible();
    await tasksLink.click();
    await expect(page).toHaveURL(/\/tasks/);
  });
});
