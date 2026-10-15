import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findJob, findProjectByChatId, loadProjectsConfig } from '../src/lib/scheduled-jobs/project-config';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scheduled-job-config-'));

  const config = (overrides = '') => `
projects:
  - id: example
    name: Example
    path: ${root}
    ref: refs/heads/main
    feishu:
      chat_id: chat-1
      approver_open_ids: [user-1]
    jobs:
      - id: scan
        type: long_file_detector
        schedule: "*/10 * * * *"
        enabled: true
        mode: shadow
        config: {}
${overrides}`;

  const load = async (source: string) => {
    const file = path.join(root, `${Math.random()}.yaml`);
    await writeFile(file, source);
    return loadProjectsConfig(file, [root]);
  };

  const valid = await load(config());
  assert.equal(findProjectByChatId(valid, 'chat-1')?.id, 'example');
  assert.equal(findJob(valid, 'example', 'scan')?.type, 'long_file_detector');

  for (const [name, source] of [
    ['duplicate chat', `${config()}\n  - id: second\n    name: Second\n    path: ${root}\n    ref: refs/heads/main\n    feishu: { chat_id: chat-1, approver_open_ids: [] }\n    jobs: []`],
    ['unknown type', config().replace('long_file_detector', 'shell')],
    ['relative path', config().replace(root, 'relative/path')],
    ['invalid cron', config().replace('*/10 * * * *', 'sometimes')],
    ['retired watcher', config('      - id: old\n        type: workflow_watcher\n        schedule: "* * * * *"\n        enabled: true\n        mode: active\n        config: {}')],
  ] as const) {
    await assert.rejects(load(source), name);
  }

  console.log('project config checks passed');
}

void main();
