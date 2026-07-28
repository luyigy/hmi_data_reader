import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertLongFilesDidNotGrow, captureLongFileBaseline, longFileNotice } from '../src/lib/long-file-guard';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'long-file-guard-'));
  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), `large_files:
  blocking_lines: 3
  source_extensions: [.ts]
  ignored_path_parts: [.git]
`);
  const file = path.join(root, 'large.ts');
  await writeFile(file, 'one\ntwo\nthree\n');
  const baseline = await captureLongFileBaseline(root);
  assert.match(longFileNotice(baseline), /large\.ts: 3 lines/);
  await writeFile(file, 'one\ntwo\nthree\nfour\n');
  await assert.rejects(assertLongFilesDidNotGrow(root, baseline), /large\.ts: 3 -> 4/);
  console.log('long file guard checks passed');
}

void main();
