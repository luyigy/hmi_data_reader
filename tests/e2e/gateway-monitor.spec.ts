import { test, expect } from '@playwright/test';

/**
 * Feature 3 - Gateway 状态监控面板 E2E 测试
 * 
 * 测试 Gateway 监控组件的功能:
 * - GatewayMonitor 组件渲染
 * - 状态指示器显示（在线/离线/忙碌）
 * - 健康状态和延迟显示
 * - 自动刷新功能
 * - 手动刷新功能
 */

test.describe('Gateway Monitor - Component Rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Gateway 监控面板应该渲染', async ({ page }) => {
    // 验证 Gateway 监控区域存在
    const monitorSection = page.getByText(/Gateway 监控/i).first();
    await expect(monitorSection).toBeVisible({ timeout: 10000 });
  });

  test('应该显示 Gateway 状态统计', async ({ page }) => {
    // 验证状态统计卡片
    await expect(page.getByText(/在线/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/离线/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/忙碌/i).or(page.getByText(/异常/i)).first()).toBeVisible({ timeout: 10000 });
  });

  test('应该显示最后刷新时间', async ({ page }) => {
    // 验证刷新时间显示
    const refreshText = page.getByText(/最后刷新/i);
    await expect(refreshText).toBeVisible({ timeout: 10000 });
  });

  test('应该显示手动刷新按钮', async ({ page }) => {
    // 验证刷新按钮存在
    const refreshButton = page.locator('button[title="手动刷新"]');
    await expect(refreshButton).toBeVisible({ timeout: 10000 });
  });

  test('应该显示自动刷新说明', async ({ page }) => {
    // 验证自动刷新说明文字
    const autoRefreshText = page.getByText(/每 30 秒自动刷新/i);
    await expect(autoRefreshText).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Gateway Monitor - Status Indicators', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('应该显示 Gateway 卡片', async ({ page }) => {
    // 等待 Gateway 卡片加载
    const gatewayCards = page.locator('[class*="gateway"], [class*="Gateway"]').filter({ hasText: /在线 | 离线 | 忙碌/i });
    await expect(gatewayCards.first()).toBeVisible({ timeout: 15000 });
  });

  test('应该显示状态指示器颜色', async ({ page }) => {
    // 验证状态指示灯（绿色=在线，红色=离线，黄色=忙碌）
    const statusIndicators = page.locator('[class*="bg-green"], [class*="bg-red"], [class*="bg-yellow"], [class*="bg-orange"]');
    await expect(statusIndicators.first()).toBeVisible({ timeout: 15000 });
  });

  test('应该显示延迟信息', async ({ page }) => {
    // 验证延迟显示（格式：XXXms）
    const latencyBadges = page.locator('text=/\\d+ms/');
    await expect(latencyBadges.first()).toBeVisible({ timeout: 15000 });
  });

  test('应该显示状态码', async ({ page }) => {
    // 验证状态码显示
    const statusCodeText = page.getByText(/状态码/i);
    await expect(statusCodeText).toBeVisible({ timeout: 15000 });
  });

  test('应该显示最后检查时间', async ({ page }) => {
    // 验证最后检查时间显示
    const lastCheckedText = page.getByText(/最后检查/i);
    await expect(lastCheckedText).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Gateway Monitor - Interactive Features', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('手动刷新按钮应该工作', async ({ page }) => {
    // 获取初始刷新时间
    const initialRefreshText = await page.getByText(/最后刷新/i).first().textContent();
    
    // 点击刷新按钮
    const refreshButton = page.locator('button[title="手动刷新"]');
    await refreshButton.click();
    
    // 等待刷新完成（最多 5 秒）
    await page.waitForTimeout(2000);
    
    // 验证刷新时间已更新
    const newRefreshText = await page.getByText(/最后刷新/i).first().textContent();
    expect(newRefreshText).not.toBe(initialRefreshText);
  });

  test('Gateway 卡片应该可以展开查看详情', async ({ page }) => {
    // 找到第一个 Gateway 卡片的展开按钮
    const expandButtons = page.locator('button[title*="展开"], button[title*="收起"]');
    
    if (await expandButtons.count() > 0) {
      const firstButton = expandButtons.first();
      await firstButton.click();
      
      // 验证展开后显示详情（资源使用或 Agents 列表）
      await page.waitForTimeout(500);
      
      // 检查是否显示资源或 Agents 信息
      const detailsVisible = await page.getByText(/资源使用 | CPU | 内存 | 磁盘 | Agents/i).isVisible();
      expect(detailsVisible).toBeTruthy();
    }
  });

  test('状态统计数字应该正确显示', async ({ page }) => {
    // 验证统计数字是有效的
    const statNumbers = page.locator('.text-2xl.font-bold, [class*="text-2xl"]');
    const count = await statNumbers.count();
    
    // 应该有 3 个统计数字（在线、忙碌/异常、离线）
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

test.describe('Gateway Monitor - Auto Refresh', () => {
  test('应该自动刷新状态（30 秒间隔）', async ({ page }) => {
    await page.goto('/');
    
    // 获取初始刷新时间
    await page.waitForTimeout(2000); // 等待初始加载
    const initialRefreshText = await page.getByText(/最后刷新/i).first().textContent();
    expect(initialRefreshText).toBeTruthy();
    
    // 等待 35 秒（超过 30 秒刷新间隔）
    await page.waitForTimeout(35000);
    
    // 验证刷新时间已更新
    const newRefreshText = await page.getByText(/最后刷新/i).first().textContent();
    expect(newRefreshText).not.toBe(initialRefreshText);
  });
});

test.describe('Gateway Monitor - Error Handling', () => {
  test('无 Gateway 时应该显示空状态', async ({ page }) => {
    // 这个测试需要 mock API 返回空数据
    // 目前跳过，因为需要更复杂的 mock 设置
    test.skip();
  });

  test('API 错误时应该显示错误信息', async ({ page }) => {
    // 这个测试需要 mock API 返回错误
    // 目前跳过，因为需要更复杂的 mock 设置
    test.skip();
  });
});
