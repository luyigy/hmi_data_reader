import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { longFileDetectorHandler } from '../src/lib/scheduled-jobs/long-file-detector';
import type { JobConfig, ProjectConfig } from '../src/lib/scheduled-jobs/project-config';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'long-file-detector-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await mkdir(path.join(root, '.next'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/example'), { recursive: true });
  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), `large_files:
  blocking_lines: 3
  source_extensions: [.ts, .js]
  ignored_path_parts: [.next, node_modules]
`);
  await writeFile(path.join(root, '.next/generated.js'), 'one\ntwo\nthree\n');
  await writeFile(path.join(root, 'node_modules/example/index.js'), 'one\ntwo\nthree\n');
  const source = path.join(root, 'large.ts');
  await writeFile(source, 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  const job: JobConfig = {
    id: 'long-file-detector',
    type: 'long_file_detector',
    schedule: '*/10 * * * *',
    enabled: true,
    mode: 'shadow',
    config: {},
  };
  const project: ProjectConfig = {
    id: 'example',
    name: 'Example',
    path: root,
    ref: 'refs/heads/main',
    feishu: { chat_id: 'unused-in-shadow', approver_open_ids: [] },
    jobs: [job],
  };
  const run = (cursor?: unknown) => longFileDetectorHandler({
    project,
    job,
    mode: 'shadow',
    cursor,
    signal: new AbortController().signal,
  });

  const first = await run();
  assert.equal(first.summary, 'offenders=1 changed=1 cleared=0');
  assert.deepEqual(Object.keys((first.cursor as { files: object }).files), ['large.ts']);
  assert.equal((await run(first.cursor)).summary, 'offenders=1 changed=0 cleared=0');

  await writeFile(source, 'changed\ncontent\nhere\n');
  git('add', 'large.ts');
  git('commit', '-qm', 'same line count');
  const changed = await run(first.cursor);
  assert.equal(changed.summary, 'offenders=1 changed=1 cleared=0');

  const requests: Array<{ url: string; body?: string }> = [];
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  global.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: init?.body?.toString() });
    return new Response(JSON.stringify(requests.length === 1
      ? { code: 0, tenant_access_token: 'token', expire: 3600 }
      : { code: 0 }));
  }) as typeof fetch;
  await longFileDetectorHandler({
    project,
    job,
    mode: 'active',
    cursor: first.cursor,
    signal: new AbortController().signal,
  });
  assert.equal(JSON.parse(requests[1].body!).receive_id, 'unused-in-shadow');
  const notification = JSON.parse(requests[1].body!).content;
  assert.match(notification, new RegExp(git('rev-parse', 'HEAD').toString().trim()));
  assert.match(notification, /本次变化 1 个（超限变化 1，恢复 0）；当前超限业务源码总数 1 个/);
  assert.doesNotMatch(notification, /\.next|node_modules/);

  await writeFile(source, 'small\n');
  git('add', 'large.ts');
  git('commit', '-qm', 'shrink');
  assert.equal((await run(changed.cursor)).summary, 'offenders=0 changed=0 cleared=1');
  console.log('long file detector checks passed');
}

void main();
