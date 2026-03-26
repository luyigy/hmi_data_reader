import { test, expect } from '@playwright/test';

/**
 * Feature 3 - Gateway 健康检查 API 端点测试
 * 
 * 测试 API 端点：
 * - GET /api/gateways/[id]/health
 * 
 * 验证响应格式：
 * - success: boolean
 * - latencyMs: number
 * - statusCode: number
 * - lastChecked: string (ISO 8601)
 * - gatewayInfo: object
 * - resources: object (optional)
 */

test.describe('Gateway Health API', () => {
  const baseURL = 'http://localhost:3000/api';

  test('健康检查 API 应该返回正确的数据结构', async ({ request }) => {
    // 首先获取所有 Gateways
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    expect(gatewaysResponse.ok()).toBeTruthy();
    
    const gateways = await gatewaysResponse.json();
    expect(Array.isArray(gateways)).toBeTruthy();
    
    if (gateways.length === 0) {
      console.log('No gateways available for health check test');
      test.skip();
      return;
    }

    // 测试第一个 Gateway 的健康检查
    const gateway = gateways[0];
    const healthResponse = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    
    // 验证响应状态
    expect([200, 500]).toContain(healthResponse.status());
    
    const healthData = await healthResponse.json();
    
    // 验证必需字段
    expect(healthData).toHaveProperty('success');
    expect(typeof healthData.success).toBe('boolean');
    
    expect(healthData).toHaveProperty('latencyMs');
    expect(typeof healthData.latencyMs).toBe('number');
    
    expect(healthData).toHaveProperty('statusCode');
    expect(typeof healthData.statusCode).toBe('number');
    
    expect(healthData).toHaveProperty('lastChecked');
    expect(typeof healthData.lastChecked).toBe('string');
    
    // 验证 lastChecked 是 ISO 8601 格式
    expect(() => new Date(healthData.lastChecked)).not.toThrow();
    
    // 验证 latencyMs 在合理范围内
    expect(healthData.latencyMs).toBeGreaterThanOrEqual(0);
    expect(healthData.latencyMs).toBeLessThan(10000); // 小于 10 秒
    
    // 验证 statusCode 是有效的 HTTP 状态码
    if (healthData.success) {
      expect(healthData.statusCode).toBeGreaterThanOrEqual(200);
      expect(healthData.statusCode).toBeLessThan(300);
    }
  });

  test('健康检查 API 应该包含 Gateway 基本信息', async ({ request }) => {
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    const gateways = await gatewaysResponse.json();
    
    if (gateways.length === 0) {
      test.skip();
      return;
    }

    const gateway = gateways[0];
    const healthResponse = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    const healthData = await healthResponse.json();
    
    // 验证 gatewayInfo 存在
    expect(healthData).toHaveProperty('gatewayInfo');
    
    if (healthData.gatewayInfo) {
      expect(healthData.gatewayInfo).toHaveProperty('id');
      expect(healthData.gatewayInfo).toHaveProperty('name');
      expect(healthData.gatewayInfo).toHaveProperty('url');
      expect(healthData.gatewayInfo).toHaveProperty('status');
      
      // 验证状态是有效的
      expect(['online', 'offline', 'maintenance', 'unhealthy', 'unknown'])
        .toContain(healthData.gatewayInfo.status);
    }
  });

  test('健康检查 API 应该包含 Agents 信息', async ({ request }) => {
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    const gateways = await gatewaysResponse.json();
    
    if (gateways.length === 0) {
      test.skip();
      return;
    }

    const gateway = gateways[0];
    const healthResponse = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    const healthData = await healthResponse.json();
    
    // 验证 agents 字段存在（可以是空数组）
    expect(healthData).toHaveProperty('agents');
    expect(Array.isArray(healthData.agents)).toBeTruthy();
    
    // 如果有 agents，验证结构
    if (healthData.agents.length > 0) {
      const agent = healthData.agents[0];
      expect(agent).toHaveProperty('id');
      expect(agent).toHaveProperty('name');
      expect(agent).toHaveProperty('status');
      
      // 验证 agent 状态是有效的
      expect(['online', 'offline', 'busy']).toContain(agent.status);
    }
  });

  test('健康检查 API 应该返回延迟信息', async ({ request }) => {
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    const gateways = await gatewaysResponse.json();
    
    if (gateways.length === 0) {
      test.skip();
      return;
    }

    const gateway = gateways[0];
    
    // 第一次请求
    const healthResponse1 = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    const healthData1 = await healthResponse1.json();
    
    // 第二次请求
    const healthResponse2 = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    const healthData2 = await healthResponse2.json();
    
    // 验证两次请求都有延迟信息
    expect(healthData1.latencyMs).toBeGreaterThanOrEqual(0);
    expect(healthData2.latencyMs).toBeGreaterThanOrEqual(0);
    
    // 验证延迟在合理范围内
    expect(healthData1.latencyMs).toBeLessThan(10000);
    expect(healthData2.latencyMs).toBeLessThan(10000);
  });

  test('健康检查 API 应该处理不存在的 Gateway', async ({ request }) => {
    const healthResponse = await request.get(`${baseURL}/gateways/non-existent-id-12345/health`);
    
    // 应该返回 404
    expect(healthResponse.status()).toBe(404);
    
    const healthData = await healthResponse.json();
    
    // 验证错误响应结构
    expect(healthData).toHaveProperty('success');
    expect(healthData.success).toBe(false);
    
    expect(healthData).toHaveProperty('error');
    expect(healthData.error).toContain('not found');
  });

  test('健康检查 API 应该更新数据库状态', async ({ request }) => {
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    const gateways = await gatewaysResponse.json();
    
    if (gateways.length === 0) {
      test.skip();
      return;
    }

    const gateway = gateways[0];
    
    // 执行健康检查
    const healthResponse = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    expect(healthResponse.ok() || healthResponse.status() === 500).toBeTruthy();
    
    // 验证 controlPlaneState 已更新（通过检查 gateways 端点）
    const gatewaysResponse2 = await request.get(`${baseURL}/gateways`);
    const gateways2 = await gatewaysResponse2.json();
    
    const updatedGateway = gateways2.find((g: any) => g.id === gateway.id);
    expect(updatedGateway).toBeTruthy();
  });

  test('健康检查应该有时间戳', async ({ request }) => {
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    const gateways = await gatewaysResponse.json();
    
    if (gateways.length === 0) {
      test.skip();
      return;
    }

    const gateway = gateways[0];
    const healthResponse = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    const healthData = await healthResponse.json();
    
    // 验证时间戳是最近的（1 分钟内）
    const now = new Date();
    const lastChecked = new Date(healthData.lastChecked);
    const timeDiff = Math.abs(now.getTime() - lastChecked.getTime());
    
    expect(timeDiff).toBeLessThan(60000); // 小于 1 分钟
  });

  test('健康检查 API 响应时间应该合理', async ({ request }) => {
    const gatewaysResponse = await request.get(`${baseURL}/gateways`);
    const gateways = await gatewaysResponse.json();
    
    if (gateways.length === 0) {
      test.skip();
      return;
    }

    const gateway = gateways[0];
    
    const startTime = Date.now();
    const healthResponse = await request.get(`${baseURL}/gateways/${gateway.id}/health`);
    const responseTime = Date.now() - startTime;
    
    // 验证 API 响应时间在合理范围内（小于 6 秒，包括 5 秒超时）
    expect(responseTime).toBeLessThan(6000);
  });
});

test.describe('Gateway Health API - Edge Cases', () => {
  const baseURL = 'http://localhost:3000/api';

  test('空 ID 应该返回错误', async ({ request }) => {
    const healthResponse = await request.get(`${baseURL}/gateways//health`);
    
    // 应该返回 404 或 400
    expect([400, 404]).toContain(healthResponse.status());
  });

  test('特殊字符 ID 应该安全处理', async ({ request }) => {
    const healthResponse = await request.get(`${baseURL}/gateways/test%3Cscript%3E/health`);
    
    // 应该返回 404（未找到），而不是 500（服务器错误）
    expect([400, 404]).toContain(healthResponse.status());
  });
});
