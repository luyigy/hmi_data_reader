/**
 * 远程网关自动注册脚本
 * 
 * 在远程 OpenClaw 实例上运行，自动向 Agent Platform 注册
 * 
 * 使用方式：
 * 1. 配置 PLATFORM_URL 和 GATEWAY_ID
 * 2. node register-remote-gateway.js
 * 3. 后台持续运行（心跳）
 */

const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:3000';
const GATEWAY_ID = process.env.GATEWAY_ID || 'gateway-office-pc';
const GATEWAY_NAME = process.env.GATEWAY_NAME || 'Office PC Gateway';
const GATEWAY_PORT = process.env.GATEWAY_PORT || '8080';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30000');

// 获取本地网关信息
async function getGatewayInfo() {
  try {
    // 读取 openclaw.json 获取配置
    const fs = require('fs');
    const path = require('path');
    
    const openclawConfigPath = path.join(
      process.env.APPDATA || process.env.HOME,
      '.openclaw',
      'openclaw.json'
    );
    
    let config = {};
    if (fs.existsSync(openclawConfigPath)) {
      config = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    }

    // 获取 agents 信息
    const agents = [];
    if (config.agents && Array.isArray(config.agents)) {
      for (const agent of config.agents) {
        agents.push({
          id: agent.id || agent.name,
          name: agent.name,
          type: agent.type || 'generic',
          capabilities: agent.capabilities || [],
          status: 'online',
        });
      }
    }

    // 获取系统资源
    const os = require('os');
    const resources = {
      cpu: `${os.cpus().length} cores`,
      memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
      platform: os.platform(),
      uptime: os.uptime(),
    };

    return {
      gatewayId: GATEWAY_ID,
      name: GATEWAY_NAME,
      ip: getLocalIP(),
      port: GATEWAY_PORT,
      agents,
      resources,
    };
  } catch (error) {
    console.error('Failed to get gateway info:', error);
    return null;
  }
}

// 获取本地 IP
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  
  return '127.0.0.1';
}

// 注册到平台
async function register() {
  const info = await getGatewayInfo();
  if (!info) {
    console.error('Failed to get gateway info');
    return false;
  }

  try {
    const response = await fetch(`${PLATFORM_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'register',
        ...info,
      }),
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ Registered successfully:', result.node?.name);
      console.log(`   Agents: ${info.agents.length}`);
      return true;
    } else {
      console.error('❌ Registration failed:', result.error);
      return false;
    }
  } catch (error) {
    console.error('❌ Registration error:', error.message);
    return false;
  }
}

// 发送心跳
async function sendHeartbeat() {
  const info = await getGatewayInfo();
  if (!info) {
    console.error('Failed to get gateway info for heartbeat');
    return false;
  }

  try {
    const response = await fetch(`${PLATFORM_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'heartbeat',
        gatewayId: GATEWAY_ID,
        agents: info.agents,
      }),
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('💓 Heartbeat sent');
      return true;
    } else {
      console.error('❌ Heartbeat failed:', result.error);
      return false;
    }
  } catch (error) {
    console.error('❌ Heartbeat error:', error.message);
    return false;
  }
}

// 注销
async function unregister() {
  try {
    const response = await fetch(`${PLATFORM_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'unregister',
        gatewayId: GATEWAY_ID,
      }),
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('👋 Unregistered successfully');
      return true;
    } else {
      console.error('❌ Unregister failed:', result.error);
      return false;
    }
  } catch (error) {
    console.error('❌ Unregister error:', error.message);
    return false;
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'register':
      await register();
      break;

    case 'heartbeat':
      await sendHeartbeat();
      break;

    case 'unregister':
      await unregister();
      break;

    case 'daemon':
    default:
      // 守护进程模式：先注册，然后定期心跳
      console.log('🚀 Starting gateway registration daemon...');
      console.log(`   Platform: ${PLATFORM_URL}`);
      console.log(`   Gateway: ${GATEWAY_ID}`);
      console.log(`   Heartbeat: every ${HEARTBEAT_INTERVAL / 1000}s`);
      
      // 首次注册
      const registered = await register();
      if (!registered) {
        console.error('Initial registration failed');
        process.exit(1);
      }

      // 定期心跳
      setInterval(async () => {
        await sendHeartbeat();
      }, HEARTBEAT_INTERVAL);

      // 优雅退出
      process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down...');
        await unregister();
        process.exit(0);
      });

      console.log('✅ Daemon started. Press Ctrl+C to stop.');
      break;
  }
}

// 运行
main().catch(console.error);
