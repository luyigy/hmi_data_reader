import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';

const projectRoot = path.resolve(__dirname, '..');

interface RunnerHandle {
  child: ChildProcess;
  stdout: () => string[];
  stderr: () => string[];
  kill: () => void;
}

const collectLines = (stream: NodeJS.ReadableStream): { lines: () => string[] } => {
  const lines: string[] = [];
  let buffer = '';
  stream.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    lines.push(...parts);
  });
  return { lines: () => lines };
};

const startRunner = (args: string[], home: string): RunnerHandle => {
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/agent-platform-runner.js'), ...args], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = collectLines(child.stdout!);
  const err = collectLines(child.stderr!);
  return {
    child,
    stdout: out.lines,
    stderr: err.lines,
    kill: () => { try { child.kill('SIGKILL'); } catch { /* already exited */ } },
  };
};

const waitForLine = async (
  lines: () => string[],
  predicate: (line: string) => boolean,
  timeoutMs: number,
  description: string,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = lines().find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}; captured: ${JSON.stringify(lines())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const listenOn = (server: Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert(address && typeof address === 'object');
    resolve(address.port);
  });
});

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => {
  server.close(() => resolve());
});

/** Reserve a port and release it so nothing listens there (simulates gateway down). */
const freePort = async (): Promise<number> => {
  const server = createServer();
  const port = await listenOn(server);
  await closeServer(server);
  return port;
};

function staticDeploymentChecks(): void {
  const unit = readFileSync(
    path.join(projectRoot, 'deploy/systemd-user/agent-platform-remote-runner-gateway.service'),
    'utf8',
  );
  // The unit must bind the gateway on all interfaces so remote runners can
  // reach it; 127.0.0.1 keeps it unreachable and looks identical to "paired".
  assert.match(unit, /^Environment=REMOTE_RUNNER_GATEWAY_HOST=0\.0\.0\.0$/m,
    'unit must set REMOTE_RUNNER_GATEWAY_HOST=0.0.0.0');
  assert.doesNotMatch(unit, /REMOTE_RUNNER_GATEWAY_HOST=127\.0\.0\.1/);

  const installer = readFileSync(path.join(projectRoot, 'scripts/install-systemd-user-services.sh'), 'utf8');
  assert.match(installer,
    /install -m 0644 "\$\{PROJECT_ROOT\}\/deploy\/systemd-user\/agent-platform-remote-runner-gateway\.service" "\$\{UNIT_DIR\}\/agent-platform-remote-runner-gateway\.service"/,
    'installer must copy the gateway unit');
  assert.match(installer, /systemctl --user enable --now agent-platform-remote-runner-gateway\.service/,
    'installer must enable and start the gateway unit');
  assert.match(installer, /echo "  agent-platform-remote-runner-gateway\.service"/,
    'installer must list the gateway unit in its output');

  // The gateway keeps honoring REMOTE_RUNNER_GATEWAY_HOST (default 127.0.0.1)
  // and the default port 3012; the unit's Environment line is the only switch,
  // so no second config file is introduced.
  const gateway = readFileSync(path.join(projectRoot, 'scripts/remote-runner-gateway.ts'), 'utf8');
  assert.match(gateway, /REMOTE_RUNNER_GATEWAY_HOST/);
  assert.match(gateway, /'127\.0\.0\.1'/);
  assert.match(gateway, /REMOTE_RUNNER_GATEWAY_PORT \|\| 3012/);

  const runner = readFileSync(path.join(projectRoot, 'scripts/agent-platform-runner.js'), 'utf8');
  assert.match(runner, /process\.platform !== 'win32'/,
    'Windows runner must use the npm .cmd-compatible launch path');
  assert.match(runner, /const encodedArgs = piArgs\.map/,
    'Windows runner must encode each Pi argument independently');
  assert.match(runner, /\[string\[\]\]\$piArgs=@\(\$\{encodedArgs\}\)/,
    'Windows PowerShell 5.1 must receive an explicit string array');
  assert.doesNotMatch(runner, /ConvertFrom-Json/,
    'Windows PowerShell 5.1 must not collapse a JSON array into one argument');
  assert.match(runner, /'-EncodedCommand'/,
    'Windows runner must launch the encoded PowerShell command');
  assert.match(runner, /const child = spawnPi\(piArgs, cwd\)/,
    'runner execution must use the cross-platform Pi launcher');
}

/** Claim succeeds but the WebSocket endpoint is unreachable: runner stays
 * observable ("paired", endpoint + reason + next retry) instead of silent. */
async function pairedButConnectionFails(): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'runner-paired-home-'));
  const workspace = mkdtempSync(path.join(tmpdir(), 'runner-paired-ws-'));
  const deadPort = await freePort();
  const deadServerUrl = `ws://127.0.0.1:${deadPort}/runner`;

  const claimServer = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { pairingToken?: string; nodeName?: string };
      assert.equal(parsed.pairingToken, 'pair-token-1');
      assert.equal(typeof parsed.nodeName, 'string');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nodeName: 't-node', nodeSecret: 't-secret', server: deadServerUrl }));
    });
  });
  const claimPort = await listenOn(claimServer);

  const runner = startRunner(
    [`--pairing-token=pair-token-1`, `--server=http://127.0.0.1:${claimPort}`, `--workspace=${workspace}`],
    home,
  );
  try {
    await waitForLine(runner.stdout, (line) => line.trim() === 'paired', 5000, 'paired marker after claim');
    await waitForLine(runner.stderr,
      (line) => /^\[runner\] connection to .+ failed: .+/.test(line), 5000,
      'websocket failure log with endpoint and reason');
    await waitForLine(runner.stderr,
      (line) => /^\[runner\] connection to .+ closed; retrying in \d+ms$/.test(line), 5000,
      'close log with endpoint and next retry delay');

    // Exponential backoff is preserved: the retry after ~1s fails again and logs again.
    await waitForLine(runner.stderr,
      (line) => /retrying in 2000ms/.test(line), 8000,
      'second retry with doubled backoff');

    // Never connected, and stdout stays terse.
    assert.ok(!runner.stdout().some((line) => line.includes('connected')),
      'no connected marker while the endpoint is unreachable');

    // Credential file behavior is unchanged.
    const config = JSON.parse(
      readFileSync(path.join(home, '.agent-platform', 'runner.json'), 'utf8'),
    ) as { server?: string; node?: string; token?: string; workspace?: string };
    assert.equal(config.server, deadServerUrl);
    assert.equal(config.node, 't-node');
    assert.equal(config.token, 't-secret');
    assert.equal(config.workspace, workspace);
  } finally {
    runner.kill();
    await closeServer(claimServer);
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

interface GatewayClient {
  on: (event: 'message', listener: (data: { toString(): string }) => void) => void;
  send: (raw: string) => void;
}

/** After the gateway accepts the connection and sends `welcome`, the runner
 * reports `connected` exactly and keeps the hello protocol intact. */
async function welcomeMeansConnected(): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'runner-connected-home-'));
  const workspace = mkdtempSync(path.join(tmpdir(), 'runner-connected-ws-'));
  const updatedWorkspace = mkdtempSync(path.join(tmpdir(), 'runner-updated-ws-'));
  const fakePi = path.join(home, 'fake-pi');
  writeFileSync(fakePi, '#!/bin/sh\necho "provider auth failed" >&2\nexit 1\n');
  chmodSync(fakePi, 0o755);

  const messages: Array<{ type?: string; runId?: string; node?: string; harnesses?: string[]; workspace?: string; requestId?: string; success?: boolean; error?: string }> = [];
  let gatewayClient: GatewayClient | undefined;
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((_req, res) => { res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url || '/', 'http://localhost');
    if (pathname !== '/runner') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws: GatewayClient) => {
      gatewayClient = ws;
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as (typeof messages)[number];
        messages.push(message);
        if (message?.type === 'hello') {
          ws.send(JSON.stringify({ type: 'welcome', nodeId: 'test-node-id', nodeName: message.node }));
        }
      });
    });
  });
  const port = await listenOn(server);

  let runner = startRunner(
    [`--server=ws://127.0.0.1:${port}/runner`, '--node=t-node', '--token=t-secret', `--workspace=${workspace}`, `--pi=${fakePi}`],
    home,
  );
  try {
    await waitForLine(runner.stdout, (line) => line.trim() === 'connected', 5000,
      'connected marker after welcome');
    const hello = messages.find((message) => message.type === 'hello');
    assert.ok(hello, 'hello frame reached the gateway');
    assert.equal(hello?.node, 't-node');
    assert.deepEqual(hello?.harnesses, ['pi-agent']);
    assert.equal(hello?.workspace, workspace);

    gatewayClient?.send(JSON.stringify({ type: 'run', runId: 'failed-run', taskId: 'task', prompt: 'go' }));
    await waitForLine(
      () => messages.map((message) => JSON.stringify(message)),
      (line) => line.includes('"type":"complete"') && line.includes('"runId":"failed-run"'),
      5000,
      'failed run completion',
    );
    assert.equal(messages.find((message) => message.type === 'complete' && message.runId === 'failed-run')?.error,
      'provider auth failed', 'completion exposes Pi stderr instead of a generic exit code');

    gatewayClient?.send(JSON.stringify({ type: 'set_workspace', requestId: 'invalid', workspace: path.join(home, 'missing') }));
    await waitForLine(
      () => messages.map((message) => JSON.stringify(message)),
      (line) => line.includes('"requestId":"invalid"') && line.includes('"success":false'),
      5000,
      'missing workspace rejection',
    );

    gatewayClient?.send(JSON.stringify({ type: 'set_workspace', requestId: 'valid', workspace: updatedWorkspace }));
    await waitForLine(
      () => messages.map((message) => JSON.stringify(message)),
      (line) => line.includes('"requestId":"valid"') && line.includes('"success":true'),
      5000,
      'workspace update acknowledgement',
    );
    await waitForLine(
      () => messages.map((message) => JSON.stringify(message)),
      (line) => line.includes('"type":"hello"') && line.includes(JSON.stringify(updatedWorkspace).slice(1, -1)),
      5000,
      'updated workspace hello',
    );
    const config = JSON.parse(readFileSync(path.join(home, '.agent-platform', 'runner.json'), 'utf8')) as { workspace?: string };
    assert.equal(config.workspace, updatedWorkspace);

    runner.kill();
    messages.splice(0);
    runner = startRunner([], home);
    await waitForLine(runner.stdout, (line) => line.trim() === 'connected', 5000, 'reconnected marker after config-only restart');
    await waitForLine(
      () => messages.map((message) => JSON.stringify(message)),
      (line) => line.includes('"type":"hello"') && line.includes(JSON.stringify(updatedWorkspace).slice(1, -1)),
      5000,
      'persisted workspace after restart',
    );

    // Silence on stderr while the connection is healthy.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(runner.stderr(), []);
  } finally {
    runner.kill();
    wss.close();
    await closeServer(server);
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(updatedWorkspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  staticDeploymentChecks();
  console.log('static gateway deployment checks passed');
  await pairedButConnectionFails();
  console.log('runner paired-but-disconnected diagnostics passed');
  await welcomeMeansConnected();
  console.log('runner welcome-connected diagnostics passed');
}

void main();
