import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

const root = mkdtempSync(path.join(tmpdir(), 'codex-tools-'));
try {
  const workspace = path.join(root, 'workspace'), bin = path.join(root, 'package/bin');
  mkdirSync(workspace); mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'codex');
  const host = path.join(bin, 'codex-code-mode-host');
  writeFileSync(executable, '#!/bin/sh\nexec "$(dirname "$0")/codex-code-mode-host"\n');
  writeFileSync(host, '#!/bin/sh\nprintf "tool-host-ok"\n');
  chmodSync(executable, 0o755); chmodSync(host, 0o755);
  const wrapped = wrapWithBubblewrap({ command: executable, commandArgs: [], cwd: workspace,
    workspaceRoot: workspace, env: process.env });
  assert.equal(execFileSync(wrapped.command, wrapped.args, { encoding: 'utf8', stdio: 'pipe' }), 'tool-host-ok');
  console.log('Isolated Codex can execute its packaged code-mode tool host');
} finally { rmSync(root, { recursive: true, force: true }); }
