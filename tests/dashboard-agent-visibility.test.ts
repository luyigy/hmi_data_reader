import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createUserSession, loadAuthConfig } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import {
  computeEffectiveAgentStatus,
  REMOTE_AGENT_HEARTBEAT_INTERVAL_MS,
  REMOTE_AGENT_OFFLINE_THRESHOLD_MS,
} from '../src/lib/agent-effective-status';
import {
  formatAgentHeartbeat,
  formatRemoteNodeLastSeen,
  NEVER_CONNECTED_LABEL,
  NEVER_HEARTBEAT_LABEL,
  UNREPORTED_CAPABILITIES_LABEL,
  UNKNOWN_TIME_LABEL,
} from '../src/lib/dashboard-display';
import { GET as getAgents } from '../src/app/api/agents/route';
import { GET as getRemoteNodes, POST as updateRemoteNode } from '../src/app/api/remote-nodes/route';
import { listRemoteNodes } from '../src/lib/remote-node-registry';

const projectRoot = path.resolve(__dirname, '..');
const seconds = (value: number) => value * 1000;

const env = {
  NODE_ENV: 'production',
  AUTH_ADMIN_USERNAME: 'admin',
  AUTH_ADMIN_PASSWORD: 'correct horse battery staple',
  AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  AUTH_SESSION_TTL_SECONDS: '3600',
  AUTH_ALLOW_INSECURE_LOCAL: 'false',
};

const request = (url: string, cookie?: string, init: RequestInit = {}) => new Request(url, {
  ...init,
  headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
});

/** ---- 1. Effective status: stored status + heartbeat freshness ---- */
function effectiveStatusTests(): void {
  // The offline threshold is fixed at 3 heartbeat cycles of the 30s cadence.
  assert.equal(REMOTE_AGENT_HEARTBEAT_INTERVAL_MS, seconds(30));
  assert.equal(REMOTE_AGENT_OFFLINE_THRESHOLD_MS, seconds(90));

  const now = new Date('2026-08-17T08:00:00Z');
  const remote = { backend: 'gateway_openclaw' };

  assert.equal(
    computeEffectiveAgentStatus({ ...remote, status: 'online', lastHeartbeat: new Date(now.getTime() - seconds(80)) }, now),
    'online',
    'fresh remote heartbeat keeps the agent online',
  );
  assert.equal(
    computeEffectiveAgentStatus({ ...remote, status: 'online', lastHeartbeat: new Date(now.getTime() - seconds(95)) }, now),
    'offline',
    'remote agent online status goes offline after 90s without heartbeat',
  );
  assert.equal(
    computeEffectiveAgentStatus({ ...remote, status: 'online', lastHeartbeat: new Date(now.getTime() - REMOTE_AGENT_OFFLINE_THRESHOLD_MS) }, now),
    'offline',
    'heartbeat exactly at the 90s threshold already reads offline',
  );
  assert.equal(
    computeEffectiveAgentStatus({ ...remote, status: 'online', lastHeartbeat: null }, now),
    'offline',
    'missing heartbeat cannot keep a remote agent online',
  );
  assert.equal(
    computeEffectiveAgentStatus({ ...remote, status: 'busy', lastHeartbeat: new Date(now.getTime() - seconds(600)) }, now),
    'busy',
    'non-online stored statuses pass through unchanged',
  );
  // Platform local keeps stored-status semantics: no real heartbeat source yet.
  assert.equal(
    computeEffectiveAgentStatus({ backend: 'platform_local', status: 'online', lastHeartbeat: new Date(now.getTime() - seconds(3600)) }, now),
    'online',
    'platform local online status survives a stale heartbeat',
  );
  assert.equal(
    computeEffectiveAgentStatus({ backend: 'unknown', status: 'online', lastHeartbeat: null }, now),
    'online',
    'unknown backends keep the stored status',
  );
  assert.equal(
    computeEffectiveAgentStatus({ backend: 'platform_local', status: 'weird', lastHeartbeat: null }, now),
    'offline',
    'unknown stored statuses normalize to offline',
  );
  console.log('effective status tests passed');
}

/** ---- 2. Missing-data display labels ---- */
function displayLabelTests(): void {
  assert.equal(UNREPORTED_CAPABILITIES_LABEL, '未上报');
  assert.equal(formatAgentHeartbeat(null), NEVER_HEARTBEAT_LABEL, 'missing heartbeat renders 从未心跳');
  assert.equal(formatAgentHeartbeat(undefined), NEVER_HEARTBEAT_LABEL);
  assert.equal(formatAgentHeartbeat(''), NEVER_HEARTBEAT_LABEL);
  assert.equal(formatAgentHeartbeat('not-a-timestamp'), UNKNOWN_TIME_LABEL, 'unparseable heartbeat renders 未知 instead of Invalid Date');
  const iso = '2026-08-17T08:00:00Z';
  const formatted = formatAgentHeartbeat(iso);
  assert.ok(formatted && formatted !== NEVER_HEARTBEAT_LABEL && formatted !== UNKNOWN_TIME_LABEL);
  assert.equal(formatted, new Date(iso).toLocaleString('zh-CN'));

  assert.equal(formatRemoteNodeLastSeen(null), NEVER_CONNECTED_LABEL, 'never-connected node renders 从未连接');
  assert.equal(formatRemoteNodeLastSeen('nope'), UNKNOWN_TIME_LABEL);
  assert.equal(formatRemoteNodeLastSeen(iso), new Date(iso).toLocaleString('zh-CN'));
  console.log('display label tests passed');
}

/** ---- 3. /api/agents response contract ---- */
async function agentsContractTests(): Promise<void> {
  const db = prisma as unknown as Record<string, { [method: string]: (...args: never[]) => Promise<unknown> }>;
  const originals = {
    upsert: db.agent.upsert,
    findMany: db.agent.findMany,
  };
  const now = Date.now();
  const gateway = { id: 'gw-1', name: 'Linux Gateway' };
  const base = {
    runtimeAgentId: null, userNickname: null, roleDescription: null,
    colorTag: null, emojiIcon: null, gateway,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const fixtures = [
    { // Remote gateway agent whose sync stopped >90s ago: must not stay online.
      id: 'agent-stale', name: 'main', type: 'openclaw', location: '远程', hostname: null,
      gatewayId: 'gw-1', status: 'online', capabilities: '[]',
      lastHeartbeat: new Date(now - seconds(120)), ...base,
    },
    { // Freshly synced remote gateway agent.
      id: 'agent-fresh', name: 'helper', type: 'openclaw', location: '远程', hostname: null,
      gatewayId: 'gw-1', status: 'online', capabilities: '["coding","review"]',
      lastHeartbeat: new Date(now - seconds(10)), ...base,
    },
    { // Platform local agent without a real heartbeat source: keeps stored status.
      id: 'agent-local', name: 'claude', type: 'claude', location: '本地', hostname: 'shaw-pi',
      gatewayId: null, status: 'online', capabilities: '[]',
      lastHeartbeat: new Date(now - seconds(3600)), ...base,
    },
  ];

  try {
    db.agent.upsert = (async (args: never) => {
      const { create } = args as { create: Record<string, unknown> };
      return { id: create.id, name: create.name, type: create.type, hostname: create.hostname, emojiIcon: create.emojiIcon, colorTag: create.colorTag };
    }) as never;
    db.agent.findMany = (async () => fixtures) as never;

    const response = await getAgents();
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<Record<string, unknown>> };
    assert.equal(body.agents.length, 3);

    // Card title + heartbeat contract: every agent exposes a display `name`
    // and an ISO `lastHeartbeat` alongside the preserved `displayName`.
    for (const agent of body.agents) {
      assert.ok(typeof agent.name === 'string' && agent.name.length > 0, `agent ${agent.id} must carry a non-empty name`);
      assert.ok(typeof agent.displayName === 'string' && agent.displayName.length > 0, 'displayName preserved for existing consumers');
      assert.equal(agent.name, agent.displayName, 'name mirrors displayName for the dashboard card');
      const heartbeat = agent.lastHeartbeat;
      assert.equal(typeof heartbeat, 'string', 'lastHeartbeat is a string');
      assert.ok(!Number.isNaN(Date.parse(heartbeat as string)), 'lastHeartbeat is ISO-parseable');
      assert.ok(Array.isArray(agent.capabilities), 'capabilities is always an array');
      assert.equal(typeof agent.storedStatus, 'string', 'storedStatus exposes the raw DB status');
    }

    const byId = Object.fromEntries(body.agents.map((agent) => [agent.id, agent]));
    assert.equal(byId['agent-stale'].status, 'offline', 'stale remote agent (120s, stored online) reads offline');
    assert.equal(byId['agent-stale'].storedStatus, 'online');
    assert.equal(byId['agent-fresh'].status, 'online', 'fresh remote agent stays online');
    assert.deepEqual(byId['agent-fresh'].capabilities, ['coding', 'review'], 'reported capabilities pass through');
    assert.deepEqual(byId['agent-stale'].capabilities, [], 'unreported capabilities stay an empty array (never fabricated)');
    assert.equal(byId['agent-local'].status, 'online', 'platform local keeps stored-status semantics despite the stale heartbeat');
  } finally {
    db.agent.upsert = originals.upsert;
    db.agent.findMany = originals.findMany;
  }
  console.log('agents api contract tests passed');
}

/** ---- 4. /api/remote-nodes response contract ---- */
async function remoteNodesContractTests(): Promise<void> {
  const db = prisma as unknown as Record<string, { [method: string]: (...args: never[]) => Promise<unknown> }>;
  const originals = {
    findMany: db.remoteNode.findMany,
    findFirst: db.remoteNode.findFirst,
    userFindUnique: db.user.findUnique,
  };
  const originalFetch = globalThis.fetch;
  const now = new Date();
  const fixtures = [
    {
      id: 'node-1', name: 'ww-ce250bc4', host: '192.168.31.50', status: 'online',
      lastSeen: now, metadata: JSON.stringify({ harnesses: ['pi-agent'], workspace: 'C:\\work\\agent' }),
      secretHash: 'sha256:do-not-leak', ownerUserId: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'node-2', name: 'spare-node', host: 'unconnected', status: 'offline',
      lastSeen: null, metadata: null,
      secretHash: 'sha256:do-not-leak', ownerUserId: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'node-3', name: 'corrupt-meta', host: '10.0.0.9', status: 'offline',
      lastSeen: new Date(now.getTime() - seconds(3600)), metadata: 'not-json',
      secretHash: 'sha256:do-not-leak', ownerUserId: null, createdAt: now, updatedAt: now,
    },
  ];
  const capturedWhere: unknown[] = [];
  const findManyMock = (async (args?: { where?: unknown }) => {
    capturedWhere.push(args?.where);
    return fixtures;
  }) as never;

  try {
    db.remoteNode.findMany = findManyMock;

    // Unauthenticated requests stay rejected (existing behavior).
    const unauthenticated = await getRemoteNodes(request('http://localhost/api/remote-nodes'));
    assert.equal(unauthenticated.status, 401);

    const config = loadAuthConfig(env as NodeJS.ProcessEnv);
    const adminToken = createUserSession({ id: 'admin', username: 'admin', role: 'admin' }, config);
    const response = await getRemoteNodes(request('http://localhost/api/remote-nodes', `ap_auth_token=${adminToken}`));
    assert.equal(response.status, 200);
    const body = await response.json() as { nodes: Array<Record<string, unknown>>; connectedCount: number };

    assert.equal(body.connectedCount, 1);
    assert.equal(body.nodes.length, 3);
    const [online, neverConnected, corrupt] = body.nodes;

    // Non-sensitive metadata contract for the Remote Runners panel.
    assert.equal(online.name, 'ww-ce250bc4');
    assert.equal(online.status, 'online');
    assert.equal(online.host, '192.168.31.50');
    assert.deepEqual(online.harnesses, ['pi-agent']);
    assert.equal(online.workspace, 'C:\\work\\agent');
    assert.ok(!Number.isNaN(Date.parse(online.lastSeen as string)), 'lastSeen serializes as ISO');

    assert.equal(neverConnected.status, 'offline');
    assert.equal(neverConnected.lastSeen, null, 'lastSeen=null stays null → 从未连接');
    assert.deepEqual(neverConnected.harnesses, []);
    assert.equal(neverConnected.workspace, null);

    assert.deepEqual(corrupt.harnesses, [], 'corrupt metadata degrades to empty harnesses');
    assert.equal(corrupt.workspace, null);

    // Never surface secrets or hashes through the API.
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /secret/i);
    assert.doesNotMatch(raw, /do-not-leak/);

    // Owner filtering keeps its existing semantics: admin sees all, users see own nodes.
    assert.equal(capturedWhere.at(-1), undefined, 'admin listing is unfiltered');
    db.user.findUnique = (async () => ({
      id: 'user-1', username: 'alice', passwordHash: 'x', role: 'user', displayName: 'Alice',
    })) as never;
    const userToken = createUserSession({ id: 'user-1', username: 'alice', role: 'user' }, config);
    const userResponse = await getRemoteNodes(request('http://localhost/api/remote-nodes', `ap_auth_token=${userToken}`));
    assert.equal(userResponse.status, 200);
    assert.deepEqual(capturedWhere.at(-1), { ownerUserId: 'user-1' }, 'user listing filters by ownerUserId');

    // Direct registry call asserts the same filter without a session.
    await listRemoteNodes({ id: 'user-2', username: 'bob', role: 'user', displayName: null });
    assert.deepEqual(capturedWhere.at(-1), { ownerUserId: 'user-2' });

    const capturedFindFirst: unknown[] = [];
    db.remoteNode.findFirst = (async (args: { where?: unknown }) => {
      capturedFindFirst.push(args.where);
      return { name: 'ww-ce250bc4' };
    }) as never;
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:3012/workspace');
      assert.deepEqual(JSON.parse(String(init?.body)), { nodeName: 'ww-ce250bc4', workspace: 'C:\\new-workspace' });
      return Response.json({ workspace: 'C:\\new-workspace' });
    }) as typeof fetch;
    const update = await updateRemoteNode(request(
      'http://localhost/api/remote-nodes',
      `ap_auth_token=${userToken}`,
      { method: 'POST', body: JSON.stringify({ id: 'node-1', workspace: 'C:\\new-workspace' }) },
    ));
    assert.equal(update.status, 200);
    assert.deepEqual(await update.json(), { workspace: 'C:\\new-workspace' });
    assert.deepEqual(capturedFindFirst.at(-1), { id: 'node-1', ownerUserId: 'user-1' }, 'workspace updates enforce node ownership');

    const unauthenticatedUpdate = await updateRemoteNode(request(
      'http://localhost/api/remote-nodes',
      undefined,
      { method: 'POST', body: JSON.stringify({ id: 'node-1', workspace: 'C:\\new-workspace' }) },
    ));
    assert.equal(unauthenticatedUpdate.status, 401);
  } finally {
    db.remoteNode.findMany = originals.findMany;
    db.remoteNode.findFirst = originals.findFirst;
    db.user.findUnique = originals.userFindUnique;
    globalThis.fetch = originalFetch;
  }
  console.log('remote nodes api contract tests passed');
}

/** ---- 5. Component wiring: no empty title / Invalid Date / blank capability area ---- */
function componentWiringTests(): void {
  const agentCard = readFileSync(path.join(projectRoot, 'src/components/dashboard/AgentCard.tsx'), 'utf8');
  assert.match(agentCard, /formatAgentHeartbeat\(agent\.lastHeartbeat\)/,
    'AgentCard renders the heartbeat through the missing-data helper');
  assert.doesNotMatch(agentCard, /new Date\(agent\.lastHeartbeat\)/,
    'AgentCard never formats the heartbeat raw (Invalid Date risk)');
  assert.match(agentCard, /UNREPORTED_CAPABILITIES_LABEL/,
    'empty capabilities render the 未上报 label instead of a blank area');
  assert.match(agentCard, /agent\.name \|\| '未命名 Agent'/,
    'the card title falls back instead of rendering empty');

  const panel = readFileSync(path.join(projectRoot, 'src/components/dashboard/RemoteRunnersPanel.tsx'), 'utf8');
  assert.match(panel, /\/api\/remote-nodes/, 'panel reads the existing remote-nodes API');
  assert.match(panel, /method: 'POST'/, 'panel persists workspace through the remote-nodes API');
  assert.match(panel, /Pi 的文件和工具访问边界/, 'panel explains the workspace security boundary');
  assert.match(panel, /node\.status !== 'online'/, 'offline runners cannot be configured');
  assert.match(panel, /formatRemoteNodeLastSeen\(node\.lastSeen\)/, 'lastSeen renders through the helper (从未连接)');
  for (const field of ['node.name', 'node.host', 'node.status', 'node.harnesses', 'node.workspace']) {
    assert.ok(panel.includes(field), `panel displays ${field}`);
  }

  const dashboard = readFileSync(path.join(projectRoot, 'src/app/page.tsx'), 'utf8');
  assert.match(dashboard, /<RemoteRunnersPanel refreshKey=\{refreshKey\} \/>/,
    'dashboard renders the Remote Runners section');
  const registry = readFileSync(path.join(projectRoot, 'src/lib/remote-node-registry.ts'), 'utf8');
  assert.doesNotMatch(registry, /secretHash[^\n]*RemoteNodeInfo|RemoteNodeInfo[^\n]*secretHash/,
    'RemoteNodeInfo stays free of secret material');
  console.log('component wiring tests passed');
}

async function main(): Promise<void> {
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    effectiveStatusTests();
    displayLabelTests();
    await agentsContractTests();
    await remoteNodesContractTests();
    componentWiringTests();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log('dashboard agent visibility tests passed');
}

void main();
