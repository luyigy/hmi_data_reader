/**
 * Feishu 通信测试脚本
 * 
 * 测试目标:
 * 1. 发送测试消息到 Agent 通信专用群 (oc_5ec3cc43833cfa94539abfbc2a7f8b8a)
 * 2. 验证消息格式和@提及解析
 * 3. 测试 Agent 响应生成
 * 
 * 使用方法:
 * npx tsx tests/test-feishu-communication.ts
 */

import { FeishuAgentRouter, createFeishuAgentRouter } from '../src/lib/feishu-agent-router';

// 测试配置
const TEST_CONFIG = {
  chatId: 'oc_5ec3cc43833cfa94539abfbc2a7f8b8a', // Agent 通信专用群
  botName: 'Control Plane',
};

async function runTests() {
  console.log('🧪 Feishu 通信测试开始\n');

  // 测试 1: 创建路由器
  console.log('✅ 测试 1: 创建 FeishuAgentRouter');
  const router = createFeishuAgentRouter({
    chatId: TEST_CONFIG.chatId,
    botName: TEST_CONFIG.botName,
  });
  console.log(`   配置：${JSON.stringify(router.getConfig(), null, 2)}\n`);

  // 测试 2: 消息解析（@提及识别）
  console.log('✅ 测试 2: 消息解析（@提及识别）');
  
  const testMessages = [
    {
      name: '包含@Control Plane 提及',
      content: '@Control Plane 执行任务',
      expected: { isMention: true, mentionedAgent: undefined },
    },
    {
      name: '包含@Agent 提及',
      content: '@Control Plane @Linux-Agent 执行任务',
      expected: { isMention: true, mentionedAgent: 'Linux-Agent' },
    },
    {
      name: '不包含提及',
      content: '普通消息',
      expected: { isMention: false, mentionedAgent: undefined },
    },
    {
      name: '包含@Agent Platform 提及',
      content: '@Agent Platform 状态查询',
      expected: { isMention: true, mentionedAgent: undefined },
    },
  ];

  for (const test of testMessages) {
    const parsed = router.parseMessage(test.content);
    const passed = parsed.isMention === test.expected.isMention &&
                   parsed.mentionedAgent === test.expected.mentionedAgent;
    
    console.log(`   ${passed ? '✅' : '❌'} ${test.name}`);
    console.log(`      内容：${test.content}`);
    console.log(`      结果：isMention=${parsed.isMention}, mentionedAgent=${parsed.mentionedAgent}`);
    if (!passed) {
      console.log(`      预期：isMention=${test.expected.isMention}, mentionedAgent=${test.expected.mentionedAgent}`);
    }
  }
  console.log();

  // 测试 3: 发送消息（模拟）
  console.log('✅ 测试 3: 发送消息（模拟）');
  
  const testContents = [
    '🧪 Feishu 通信测试消息',
    '@Linux-Agent 请回复',
    '✅ 测试完成',
  ];

  for (const content of testContents) {
    console.log(`   发送：${content}`);
    const result = await router.sendMessage(content);
    console.log(`   结果：${result.success ? '✅ 成功' : '❌ 失败'} ${result.messageId || result.error}`);
  }
  console.log();

  // 测试 4: Agent 响应生成
  console.log('✅ 测试 4: Agent 响应生成');
  
  const responses = [
    { agent: 'Linux-Agent', response: '任务执行完成' },
    { agent: 'Codex-Agent', response: '代码分析完成' },
    { agent: 'Claude-Agent', response: '文本处理完成' },
  ];

  for (const { agent, response } of responses) {
    console.log(`   ${agent}: ${response}`);
    const result = await router.sendAgentResponse(agent, response);
    console.log(`   结果：${result.success ? '✅ 成功' : '❌ 失败'} ${result.messageId || result.error}`);
  }
  console.log();

  // 测试 5: 消息处理回调
  console.log('✅ 测试 5: 消息处理回调');
  
  const messageHandler = async (message: any) => {
    console.log(`   收到消息：${message.content}`);
    console.log(`   提及：${message.isMention ? '是' : '否'}`);
    if (message.mentionedAgent) {
      console.log(`   提及 Agent: ${message.mentionedAgent}`);
    }
    
    // 模拟响应
    if (message.isMention) {
      await router.sendAgentResponse('Test-Agent', `收到消息：${message.content}`);
    }
  };

  const testRouter = createFeishuAgentRouter({
    chatId: TEST_CONFIG.chatId,
    botName: TEST_CONFIG.botName,
    onMessage: messageHandler,
  });

  // 模拟接收消息
  const rawMessages = [
    { content: '@Control Plane 测试消息 1', author_id: 'user_1' },
    { content: '@Control Plane @Linux-Agent 测试消息 2', author_id: 'user_2' },
    { content: '普通消息（不应触发）', author_id: 'user_3' },
  ];

  for (const rawMessage of rawMessages) {
    console.log(`   模拟接收：${rawMessage.content}`);
    await testRouter.handleMessage(rawMessage);
  }
  console.log();

  // 测试 6: 监听器启动/停止
  console.log('✅ 测试 6: 监听器启动/停止');
  
  testRouter.startListening();
  console.log(`   监听状态：${testRouter.isListening() ? '运行中' : '已停止'}`);
  
  setTimeout(() => {
    testRouter.stopListening();
    console.log(`   监听状态：${testRouter.isListening() ? '运行中' : '已停止'}`);
    console.log('\n🎉 所有测试完成！');
  }, 1000);
}

// 运行测试
runTests().catch(console.error);
