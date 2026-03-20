/**
 * Control Plane 使用示例
 * 
 * 演示如何初始化和使用 Control Plane 组件
 */

import { GatewayManager, GatewayClient, FeishuCommandRouter } from './index';
import type { GatewayConfig, FeishuCommandRouterConfig } from './types';

/**
 * 示例 1: 初始化 GatewayManager
 */
async function example1_InitGatewayManager() {
  const manager = new GatewayManager();

  // 注册 Gateway
  const gatewayConfig: GatewayConfig = {
    id: 'gateway-office',
    name: 'Office Gateway',
    url: 'http://192.168.1.100:3000',
    token: 'your-gateway-token-here',
    priority: 1,
  };

  await manager.registerGateway(gatewayConfig);

  // 启动健康检查
  manager.startHealthCheck(30000); // 30 秒间隔

  // 订阅事件
  manager.on('gateway:online', (data) => {
    console.log(`Gateway ${data.gatewayId} is online`);
  });

  manager.on('gateway:offline', (data) => {
    console.log(`Gateway ${data.gatewayId} is offline: ${data.reason}`);
  });

  return manager;
}

/**
 * 示例 2: 分配任务
 */
async function example2_AssignTask(manager: GatewayManager) {
  const task = {
    id: 'task-001',
    type: 'code-review',
    description: 'Review PR #123',
    payload: {
      prUrl: 'https://github.com/repo/pull/123',
    },
    priority: 8,
    timeoutMs: 300000, // 5 分钟
  };

  const result = await manager.assignTask(task);

  if (result.success) {
    console.log(`Task assigned to ${result.assignedGatewayId}`);
  } else {
    console.error(`Task assignment failed: ${result.error}`);
  }
}

/**
 * 示例 3: 广播任务
 */
async function example3_BroadcastTask(manager: GatewayManager) {
  const task = {
    id: 'broadcast-001',
    type: 'sync-config',
    description: 'Sync configuration to all gateways',
    payload: {
      configVersion: '1.2.3',
    },
  };

  const result = await manager.broadcastTask(task);

  console.log(`Broadcast result: ${result.success}/${result.total} successful`);
}

/**
 * 示例 4: 选择最优 Gateway
 */
async function example4_SelectGateway(manager: GatewayManager) {
  // Round Robin
  const gateway1 = await manager.selectBestGateway({ strategy: 'round-robin' });
  console.log(`Selected (round-robin): ${gateway1}`);

  // Least Loaded
  const gateway2 = await manager.selectBestGateway({ strategy: 'least-loaded' });
  console.log(`Selected (least-loaded): ${gateway2}`);

  // Latency-based
  const gateway3 = await manager.selectBestGateway({ strategy: 'latency-based' });
  console.log(`Selected (latency-based): ${gateway3}`);
}

/**
 * 示例 5: 初始化 FeishuCommandRouter
 */
async function example5_InitFeishuRouter(manager: GatewayManager) {
  const config: FeishuCommandRouterConfig = {
    appId: 'cli_a1b2c3d4e5f6',
    appSecret: 'your-app-secret',
    verificationToken: 'your-verification-token',
    pollingIntervalMs: 5000,
  };

  const router = new FeishuCommandRouter(config, manager);

  // 注册自定义命令
  router.registerHandler('deploy', async (command) => {
    const environment = command.options['env'] || 'staging';
    const version = command.args[0] || 'latest';

    // 执行部署逻辑
    return {
      success: true,
      response: `🚀 Deploying ${version} to ${environment}...`,
      executedCommand: 'deploy',
      timestamp: new Date(),
    };
  });

  // 启动监听器
  router.startListener();

  return router;
}

/**
 * 示例 6: 处理飞书消息
 */
async function example6_HandleMessage(router: FeishuCommandRouter) {
  // 模拟飞书消息
  const message = {
    message_id: 'msg_001',
    root_id: 'msg_001',
    parent_id: '',
    create_time: new Date().toISOString(),
    msg_type: 'text' as const,
    content: '@Agent Platform execute --gateway=gateway-1 "Analyze codebase"',
    chat_id: 'oc_123456',
    author_id: 'ou_789',
    mentions: ['ou_789'],
  };

  await router.handleMessage(message);
}

/**
 * 完整示例
 */
async function main() {
  console.log('🚀 Control Plane Example Starting...\n');

  try {
    // 1. 初始化 GatewayManager
    console.log('Step 1: Initialize GatewayManager');
    const manager = await example1_InitGatewayManager();

    // 等待 Gateway 连接
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 2. 分配任务
    console.log('\nStep 2: Assign Task');
    await example2_AssignTask(manager);

    // 3. 广播任务
    console.log('\nStep 3: Broadcast Task');
    await example3_BroadcastTask(manager);

    // 4. 选择 Gateway
    console.log('\nStep 4: Select Gateway');
    await example4_SelectGateway(manager);

    // 5. 初始化飞书路由
    console.log('\nStep 5: Initialize FeishuCommandRouter');
    const router = await example5_InitFeishuRouter(manager);

    // 6. 处理消息
    console.log('\nStep 6: Handle Message');
    await example6_HandleMessage(router);

    console.log('\n✅ Example completed successfully!');

    // 清理
    // manager.stopHealthCheck();
    // router.stopListener();
  } catch (error) {
    console.error('❌ Example failed:', error);
  }
}

// 运行示例
if (require.main === module) {
  main();
}
