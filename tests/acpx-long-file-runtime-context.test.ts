import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertLongFileRuntimeContext, getLongFileRuntimeContext, longFileRuntimeNotice } from '../src/lib/acpx/long-file-runtime-context';
import { buildHarnessPrompt, withFeishuBotContactInstructions, withLongFileRuntimeContext } from '../src/lib/acpx/prompt';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acpx-long-file-context-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await mkdir(path.join(root, 'ignored'), { recursive: true });
  await mkdir(path.join(root, 'nested', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await writeFile(path.join(root, 'large.ts'), 'one\ntwo\nthree\n');
  await writeFile(path.join(root, 'nested', 'large.py'), 'one\ntwo\nthree\n');
  await writeFile(path.join(root, 'ignored', 'large.ts'), 'one\ntwo\nthree\n');
  await writeFile(path.join(root, 'nested', 'node_modules', 'large.ts'), 'one\ntwo\nthree\n');
  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), `large_files:
  blocking_lines: 3
  source_extensions: [.ts, .py]
  ignored_path_parts: [ignored, node_modules]
`);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-qm', 'initial');
  await writeFile(path.join(root, 'large.ts'), 'one\ntwo\nthree\nfour\n');

  const config = path.join(root, 'projects.yaml');
  await writeFile(config, `projects:
  - id: example
    name: Example
    path: ${root}
    ref: refs/heads/main
    feishu: { chat_id: chat-1, approver_open_ids: [] }
    jobs:
      - id: scan
        type: long_file_detector
        schedule: "*/10 * * * *"
        enabled: true
        mode: shadow
        config: {}
`);
  const options = { executionBackend: 'platform_local' as const, workingDirectory: path.join(root, 'nested'), projectsFile: config, workspaceRoots: [os.tmpdir()] };
  const context = await getLongFileRuntimeContext(options);
  assert.deepEqual(context?.offenders, [{ path: 'large.ts', lines: 4 }, { path: 'nested/large.py', lines: 3 }]);
  assert.equal(context?.baseline['ignored/large.ts'], undefined);
  assert.equal(context?.baseline['nested/node_modules/large.ts'], undefined);
  assert.match(longFileRuntimeNotice(context!), /example @ [0-9a-f]{40}/);
  await assertLongFileRuntimeContext(context!);
  await writeFile(path.join(root, 'large.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(path.join(root, 'new.py'), 'one\ntwo\nthree\n');
  await assert.rejects(
    assertLongFileRuntimeContext(context!),
    /large\.ts: 4 -> 5[\s\S]*new\.py: 0 -> 3/,
  );
  const continuation = withLongFileRuntimeContext('Continue the task.', context);
  assert.match(continuation, /Historical over-limit files must not grow/);
  assert.match(continuation, /Continue the task\.$/);
  assert.equal(withLongFileRuntimeContext('Continue the task.', null), 'Continue the task.');
  assert.equal(withLongFileRuntimeContext('Continue the task.', { ...context!, offenders: [] }), 'Continue the task.');
  const prompt = buildHarnessPrompt(
    { taskName: 'Example', taskDescription: null } as never,
    { role: 'custom', harnessType: 'codex', gatewayName: 'Local', executionBackend: 'platform_local' } as never,
    [],
    { transcript: '', latestUserMessage: null },
    null,
    context,
  );
  assert.match(prompt, /Long-file baseline: example/);
  assert.match(prompt, /automatically use lark-im-mention-bots/);
  const botContinuation = withFeishuBotContactInstructions('Continue the task.');
  assert.match(botContinuation, /^Continue the task\./);
  assert.match(botContinuation, /--as bot/);
  assert.match(botContinuation, /read back mentions/);
  assert.doesNotMatch(prompt, /Antigravity completion contract/);
  const antigravityPrompt = buildHarnessPrompt(
    { taskName: 'Example', taskDescription: null } as never,
    { role: 'custom', harnessType: 'antigravity', gatewayName: 'Local', executionBackend: 'platform_local' } as never,
    [],
    { transcript: 'Earlier work.', latestUserMessage: null },
  );
  assert.match(antigravityPrompt, /A progress update or promise to report later is not a final response/);
  assert.match(antigravityPrompt, /automatically use lark-im-mention-bots/);
  assert.match(antigravityPrompt, /Explicitly state whether the task completed, failed, or is blocked/);
  assert.equal(await getLongFileRuntimeContext({ ...options, executionBackend: 'remote_ssh' }), null);
  assert.equal(await getLongFileRuntimeContext({ ...options, workingDirectory: os.tmpdir() }), null);
  await writeFile(config, (await readFile(config, 'utf8')).replace('enabled: true', 'enabled: false'));
  assert.equal(await getLongFileRuntimeContext(options), null);
  console.log('ACPX long-file runtime context checks passed');
}

void main();
