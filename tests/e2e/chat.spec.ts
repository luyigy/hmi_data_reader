import { test, expect } from '@playwright/test';

test.describe('Chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat');
  });

  test('should display chat page', async ({ page }) => {
    await expect(page).toHaveTitle(/Agent Platform/);
    await expect(page.getByRole('heading', { name: /chat/i })).toBeVisible();
  });

  test('should display chat input', async ({ page }) => {
    const chatInput = page.getByRole('textbox', { name: /message/i });
    await expect(chatInput).toBeVisible();
  });

  test('should display send button', async ({ page }) => {
    const sendButton = page.getByRole('button', { name: /send/i });
    await expect(sendButton).toBeVisible();
  });

  test('should display chat messages list', async ({ page }) => {
    // Check for message list container
    const messageList = page.locator('[class*="message"], [class*="chat"]');
    await expect(messageList.first()).toBeVisible({ timeout: 10000 });
  });

  test('should support @mention autocomplete', async ({ page }) => {
    const chatInput = page.getByRole('textbox', { name: /message/i });
    
    // Type @ to trigger autocomplete
    await chatInput.fill('@');
    await page.waitForTimeout(500);
    
    // Check for autocomplete dropdown
    const autocompleteDropdown = page.locator('[class*="mention"], [class*="autocomplete"], [role="listbox"]');
    await expect(autocompleteDropdown).toBeVisible({ timeout: 5000 });
  });

  test('should send a message', async ({ page }) => {
    const chatInput = page.getByRole('textbox', { name: /message/i });
    const sendButton = page.getByRole('button', { name: /send/i });
    
    // Type a test message
    await chatInput.fill('E2E test message - ' + new Date().toISOString());
    
    // Click send
    await sendButton.click();
    
    // Wait for message to appear
    await page.waitForTimeout(1000);
    
    // Verify message is displayed
    await expect(page.getByText(/E2E test message/)).toBeVisible({ timeout: 5000 });
  });

  test('should @mention an agent', async ({ page }) => {
    const chatInput = page.getByRole('textbox', { name: /message/i });
    
    // Type @Agent to trigger autocomplete
    await chatInput.fill('@Agent');
    await page.waitForTimeout(500);
    
    // Select first agent from autocomplete
    const firstAgentOption = page.locator('[role="option"], [class*="mention-option"]').first();
    if (await firstAgentOption.isVisible({ timeout: 3000 })) {
      await firstAgentOption.click();
      await page.waitForTimeout(500);
      
      // Add message text
      await chatInput.pressSequential(' Test message for agent');
      
      // Send message
      const sendButton = page.getByRole('button', { name: /send/i });
      await sendButton.click();
      
      // Verify message is displayed
      await page.waitForTimeout(1000);
      await expect(page.getByText(/Test message for agent/)).toBeVisible({ timeout: 5000 });
    }
  });
});
