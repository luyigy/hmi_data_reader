import { test, expect } from '@playwright/test';

test.describe('API Endpoints', () => {
  const baseURL = 'http://localhost:3000/api';

  test('GET /api/agents should return agent list', async ({ request }) => {
    const response = await request.get(`${baseURL}/agents`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
    expect(data.length).toBeGreaterThan(0);
    
    // Verify agent structure
    const agent = data[0];
    expect(agent).toHaveProperty('id');
    expect(agent).toHaveProperty('name');
    expect(agent).toHaveProperty('status');
    expect(agent).toHaveProperty('type');
  });

  test('GET /api/gateways should return gateway list', async ({ request }) => {
    const response = await request.get(`${baseURL}/gateways`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
    
    // Verify gateway structure
    if (data.length > 0) {
      const gateway = data[0];
      expect(gateway).toHaveProperty('id');
      expect(gateway).toHaveProperty('name');
      expect(gateway).toHaveProperty('url');
    }
  });

  test('GET /api/chat/rooms should return chat rooms', async ({ request }) => {
    const response = await request.get(`${baseURL}/chat/rooms`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('POST /api/chat/messages should create message', async ({ request }) => {
    const testMessage = `E2E API test - ${new Date().toISOString()}`;
    
    const response = await request.post(`${baseURL}/chat/messages`, {
      data: {
        content: testMessage,
        authorId: 'e2e-test-user',
        roomId: 'default'
      }
    });
    
    // Should return 200 or 201
    expect(response.status()).toBeLessThan(300);
    
    const data = await response.json();
    expect(data).toHaveProperty('id');
    expect(data.content).toContain('E2E API test');
  });

  test('GET /api/agents/[id] should return single agent', async ({ request }) => {
    // First get the list to find a valid ID
    const listResponse = await request.get(`${baseURL}/agents`);
    const agents = await listResponse.json();
    
    if (agents.length > 0) {
      const agentId = agents[0].id;
      const response = await request.get(`${baseURL}/agents/${agentId}`);
      expect(response.ok()).toBeTruthy();
      
      const data = await response.json();
      expect(data.id).toBe(agentId);
      expect(data).toHaveProperty('name');
    }
  });

  test('PUT /api/agents/[id] should update agent status', async ({ request }) => {
    // First get the list to find a valid ID
    const listResponse = await request.get(`${baseURL}/agents`);
    const agents = await listResponse.json();
    
    if (agents.length > 0) {
      const agentId = agents[0].id;
      const response = await request.put(`${baseURL}/agents/${agentId}`, {
        data: {
          status: 'online'
        }
      });
      
      expect(response.ok()).toBeTruthy();
      
      const data = await response.json();
      expect(data.status).toBe('online');
    }
  });
});
