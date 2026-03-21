/**
 * 远程网关自动注册脚本
 * 在远程 OpenClaw 实例上运行，自动向 Agent Platform 注册
 */

const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:3000';
const GATEWAY_ID = process.env.GATEWAY_ID || 'gateway-office-pc';
const GATEWAY_NAME = process.env.GATEWAY_NAME || 'Office PC Gateway';
const GATEWAY_PORT = process.env.GATEWAY_PORT || '8080';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);
const PREFERRED_IP = process.env.GATEWAY_IP || '';
const RUNTIME_AGENTS_JSON = process.env.RUNTIME_AGENTS_JSON || '';
const RUNTIME_AGENTS_FILE = process.env.RUNTIME_AGENTS_FILE || '';

function getAuthHeaders() {
  if (!GATEWAY_TOKEN) {
    throw new Error('GATEWAY_TOKEN is required. Generate it from /api/gateways/token first.');
  }

  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + GATEWAY_TOKEN,
  };
}

function normalizeAgent(agent, index) {
  const fallbackName = typeof agent.name === 'string' && agent.name.trim()
    ? agent.name.trim()
    : `agent-${index + 1}`;

  const runtimeAgentId =
    (typeof agent.runtimeAgentId === 'string' && agent.runtimeAgentId.trim()) ||
    (typeof agent.openclawAgentId === 'string' && agent.openclawAgentId.trim()) ||
    (typeof agent.acpAgentId === 'string' && agent.acpAgentId.trim()) ||
    (typeof agent.agentId === 'string' && agent.agentId.trim()) ||
    (typeof agent.id === 'string' && agent.id.trim()) ||
    fallbackName;

  return {
    id:
      (typeof agent.id === 'string' && agent.id.trim()) ||
      runtimeAgentId ||
      fallbackName,
    runtimeAgentId,
    name: fallbackName,
    type:
      (typeof agent.type === 'string' && agent.type.trim()) ||
      'generic',
    capabilities: Array.isArray(agent.capabilities)
      ? agent.capabilities.filter(Boolean)
      : [],
    status:
      (typeof agent.status === 'string' && agent.status.trim()) ||
      'online',
  };
}

function parseRuntimeAgentsOverride(fs) {
  try {
    if (RUNTIME_AGENTS_JSON) {
      const parsed = JSON.parse(RUNTIME_AGENTS_JSON);
      if (!Array.isArray(parsed)) {
        throw new Error('RUNTIME_AGENTS_JSON must be a JSON array');
      }
      return parsed.map(normalizeAgent);
    }

    if (RUNTIME_AGENTS_FILE) {
      const content = fs.readFileSync(RUNTIME_AGENTS_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error('RUNTIME_AGENTS_FILE must point to a JSON array file');
      }
      return parsed.map(normalizeAgent);
    }
  } catch (error) {
    console.error('Failed to parse runtime agent overrides:', error.message);
    process.exit(1);
  }

  return null;
}

async function getGatewayInfo() {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const openclawConfigPath = path.join(
      process.env.APPDATA || process.env.HOME,
      '.openclaw',
      'openclaw.json'
    );

    let config = {};
    if (fs.existsSync(openclawConfigPath)) {
      config = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    }

    const overrideAgents = parseRuntimeAgentsOverride(fs);
    const agents = [];

    if (overrideAgents) {
      agents.push(...overrideAgents);
    } else if (config.agents && Array.isArray(config.agents)) {
      for (let index = 0; index < config.agents.length; index += 1) {
        agents.push(normalizeAgent(config.agents[index], index));
      }
    }

    const resources = {
      cpu: String(os.cpus().length) + ' cores',
      memory: String(Math.round(os.totalmem() / 1024 / 1024 / 1024)) + 'GB',
      platform: os.platform(),
      uptime: os.uptime(),
    };

    return {
      gatewayId: GATEWAY_ID,
      name: GATEWAY_NAME,
      ip: PREFERRED_IP || getLocalIP(),
      port: GATEWAY_PORT,
      agents: agents,
      resources: resources,
    };
  } catch (error) {
    console.error('Failed to get gateway info:', error);
    return null;
  }
}

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

async function postRegistrationAction(action, payload) {
  const response = await fetch(PLATFORM_URL + '/api/gateways/register', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });

  const result = await response.json();
  return { response: response, result: result };
}

async function register() {
  const info = await getGatewayInfo();
  if (!info) {
    console.error('Failed to get gateway info');
    return false;
  }

  try {
    const outcome = await postRegistrationAction('register', info);

    if (outcome.response.ok) {
      console.log('Registered successfully:', outcome.result.gateway && outcome.result.gateway.name ? outcome.result.gateway.name : info.name);
      console.log('Gateway ID:', GATEWAY_ID);
      console.log('Reported URL: http://' + info.ip + ':' + info.port);
      console.log('Agents:', info.agents.length);
      console.log('Runtime agent IDs:', info.agents.map(function (agent) {
        return agent.runtimeAgentId;
      }).join(', ') || '(none)');
      return true;
    }

    console.error('Registration failed:', outcome.result.error || outcome.response.statusText);
    return false;
  } catch (error) {
    console.error('Registration error:', error.message);
    return false;
  }
}

async function sendHeartbeat() {
  const info = await getGatewayInfo();
  if (!info) {
    console.error('Failed to get gateway info for heartbeat');
    return false;
  }

  try {
    const outcome = await postRegistrationAction('heartbeat', {
      gatewayId: GATEWAY_ID,
      ip: info.ip,
      port: info.port,
      agents: info.agents,
    });

    if (outcome.response.ok) {
      console.log('Heartbeat sent. Runtime agent IDs:', info.agents.map(function (agent) {
        return agent.runtimeAgentId;
      }).join(', ') || '(none)');
      return true;
    }

    console.error('Heartbeat failed:', outcome.result.error || outcome.response.statusText);
    return false;
  } catch (error) {
    console.error('Heartbeat error:', error.message);
    return false;
  }
}

async function unregister() {
  try {
    const outcome = await postRegistrationAction('unregister', {
      gatewayId: GATEWAY_ID,
    });

    if (outcome.response.ok) {
      console.log('Unregistered successfully');
      return true;
    }

    console.error('Unregister failed:', outcome.result.error || outcome.response.statusText);
    return false;
  } catch (error) {
    console.error('Unregister error:', error.message);
    return false;
  }
}

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
      console.log('Starting gateway registration daemon...');
      console.log('Platform:', PLATFORM_URL);
      console.log('Gateway:', GATEWAY_ID);
      console.log('Heartbeat every', HEARTBEAT_INTERVAL / 1000, 'seconds');
      if (RUNTIME_AGENTS_JSON) {
        console.log('Using runtime agents from RUNTIME_AGENTS_JSON');
      } else if (RUNTIME_AGENTS_FILE) {
        console.log('Using runtime agents from file:', RUNTIME_AGENTS_FILE);
      } else {
        console.log('Using runtime agents from ~/.openclaw/openclaw.json when available');
      }

      if (!GATEWAY_TOKEN) {
        console.error('Missing GATEWAY_TOKEN');
        process.exit(1);
      }

      {
        const registered = await register();
        if (!registered) {
          console.error('Initial registration failed');
          process.exit(1);
        }
      }

      setInterval(async function () {
        await sendHeartbeat();
      }, HEARTBEAT_INTERVAL);

      process.on('SIGINT', async function () {
        console.log('\nShutting down...');
        await unregister();
        process.exit(0);
      });

      console.log('Daemon started. Press Ctrl+C to stop.');
      break;
  }
}

main().catch(console.error);
