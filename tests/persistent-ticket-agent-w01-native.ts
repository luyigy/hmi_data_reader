import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCodexAppServer, type CodexAppServerOptions } from '../src/lib/real-agents/codex-app-server';
import { withSandbox, type SandboxIdentity } from '../src/lib/sandbox-manager';
import type { HarnessSandbox } from '../src/lib/harness/types';
import { linkedWorktreeGitDirectories } from '../src/lib/real-agents/git-worktree-paths';

/** The provider is deterministic loopback SSE. The Codex binary, shell tools, persisted thread and Sandbox Manager are real. */
export async function verifyNativeWorkspace(workspace: string, sibling: string, outputRoot: string) {
  const cache = path.join(os.homedir(), '.cache', 'agent-platform-native-tests');
  await fs.mkdir(cache, { recursive: true });
  const runtime = await fs.mkdtemp(path.join(cache, 'w01-'));
  const toolOutputs: string[] = [];
  let requests = 0;
  let turn = 0;
  let toolSent = false;
  const commands = [
    `printf first > first.txt; test ! -e '${sibling}/file.txt' || exit 17; gitdir=$(sed 's/^gitdir: //' .git); if touch "$gitdir/w01-forbidden" 2>/dev/null; then exit 18; fi; printf isolation-ok`,
    'test "$(cat first.txt)" = first && printf second > second.txt && printf resumed-ok',
  ];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const raw: unknown = JSON.parse(body);
        if (!raw || typeof raw !== 'object' || !('tools' in raw) || !Array.isArray(raw.tools)) throw new Error('Missing native tool declarations');
        const names = raw.tools.map((tool: unknown) => tool && typeof tool === 'object' && 'name' in tool ? tool.name : null);
        const name = names.includes('exec_command') ? 'exec_command' : names.includes('shell_command') ? 'shell_command' : 'shell';
        assert.ok(names.includes(name));
        if ('input' in raw && Array.isArray(raw.input)) for (const item of raw.input) {
          if (item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output' && 'output' in item) toolOutputs.push(JSON.stringify(item.output));
        }
        requests++;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const id = `w01-response-${requests}`;
        emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
        const command = commands[turn];
        const toolArgs = name === 'exec_command' ? { cmd: command, yield_time_ms: 1000 } : name === 'shell_command' ? { command } : { command: ['bash', '-c', command] };
        const item = !toolSent
          ? { id: `call-${requests}`, type: 'function_call', call_id: `w01-${requests}`, name, arguments: JSON.stringify(toolArgs), status: 'completed' }
          : { id: `msg-${requests}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'W01 turn complete', annotations: [] }] };
        toolSent = true;
        emit('response.output_item.added', { output_index: 0, item });
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
        response.end();
      } catch (error) {
        response.writeHead(500); response.end(String(error));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback listener missing');
    await fs.writeFile(path.join(runtime, 'config.toml'), `model = "gpt-test"\nmodel_provider = "fixture"\n[features]\ncode_mode = false\n[model_providers.fixture]\nname = "W01 loopback fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    const identities: SandboxIdentity[] = [];
    let closed = 0;
    const sandbox: HarnessSandbox = { run: (input, use) => withSandbox(input, async managed => {
      assert.ok(managed.identity, 'Manager process identity required');
      identities.push(managed.identity);
      managed.control.onClosed(() => { closed++; });
      return use(managed);
    }) };
    const options = { workingDirectory: workspace, workspaceRoot: workspace, runtimeHome: runtime, codexHome: runtime,
      readOnlyPaths: linkedWorktreeGitDirectories(workspace), sandbox,
      networkAccess: 'enabled', sandboxMode: 'workspace-write', approvalPolicy: 'never', timeout: 25000,
      env: { PATH: process.env.PATH, HOME: runtime, CODEX_HOME: runtime, AP_GRAPH_WRITER_NONCE: process.env.AP_GRAPH_WRITER_NONCE } } satisfies Omit<CodexAppServerOptions, 'prompt'>;
    const first = await runCodexAppServer({ ...options, prompt: 'Run the first implementation command and check isolation.' });
    assert.ok(first.threadId, 'Native thread identity must be persisted');
    assert.equal(closed, 1, 'Manager must reap first root before resuming');
    assert.equal(await fs.readFile(path.join(workspace, 'first.txt'), 'utf8'), 'first');
    turn = 1; toolSent = false;
    const resumed = await runCodexAppServer({ ...options, prompt: 'Continue the same implementation and read the previous file.', threadId: first.threadId });
    assert.equal(resumed.threadId, first.threadId);
    assert.equal(closed, 2);
    assert.equal(await fs.readFile(path.join(workspace, 'second.txt'), 'utf8'), 'second');
    for (const gitDir of linkedWorktreeGitDirectories(workspace)) assert.equal(await fs.access(path.join(gitDir, 'w01-forbidden')).then(() => true, () => false), false);
    assert.equal(identities.length, 2);
    assert.ok(identities.every(identity => identity.backend === 'bubblewrap'));
    assert.ok(toolOutputs.some(output => output.includes('isolation-ok')), 'Shell must finish isolation checks successfully');
    assert.ok(toolOutputs.some(output => output.includes('resumed-ok')), 'Shell must read first turn file and finish second turn');
    const evidence = { provider: 'deterministic loopback fixture', executable: 'real installed Codex', threadId: first.threadId, resumedThreadId: resumed.threadId,
      requests, toolOutputs, managerRoots: identities, rootsClosed: closed, workspace, sibling, results: ['first.txt=first', 'second.txt=second', 'sibling inaccessible', 'Git metadata not writable'] };
    await fs.writeFile(path.join(outputRoot, 'native-evidence.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(runtime, { recursive: true, force: true });
  }
}
