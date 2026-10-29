import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeRemoteSshTask, probeRemoteSshHost } from '../src/lib/remote-harness/ssh-executor';

void (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ssh-windows-fallback-'));
  const originalPath = process.env.PATH;
  const originalError = process.env.SSH_TEST_ERROR;
  const host = {
    id: 'test', label: 'test', host: 'test', port: 22, sshUser: 'test',
    authType: 'ssh_key', privateKey: 'test-key', workingDirectory: 'D:\\Code',
    status: 'online', viaNetwork: 'test', supportedHarnesses: ['pi-agent'],
  };
  try {
    const ssh = path.join(dir, 'ssh');
    await writeFile(ssh, `#!/bin/sh
for arg do command="$arg"; done
case "$command" in
  bash*) printf '%s\\n' "$SSH_TEST_ERROR" >&2; exit 1 ;;
  powershell.exe*) cat >/dev/null; printf 'pi-agent=ok 0.85.1\\n' ;;
  *) exit 2 ;;
esac
`);
    await chmod(ssh, 0o755);
    process.env.PATH = `${dir}:${originalPath || ''}`;
    for (const message of [
      "'bash' is not recognized as an internal or external command",
      "'bash' 不是内部或外部命令，也不是可运行的程序或批处理文件。",
      "Warning: Permanently added 'test' to the list of known hosts.\r\n'bash' �����ڲ����ⲿ���Ҳ���ǿ����еĳ���\r\n���������ļ���",
    ]) {
      process.env.SSH_TEST_ERROR = message;
      assert.equal((await probeRemoteSshHost(host)).output.trim(), 'pi-agent=ok 0.85.1');
      assert.equal((await executeRemoteSshTask({ id: 'test', name: 'test' }, {
        host, harnessType: 'pi-agent', timeout: 5_000,
      })).output.trim(), 'pi-agent=ok 0.85.1');
    }
    for (const message of ['Permission denied (publickey).', 'Connection refused', 'bash: pi: command not found']) {
      process.env.SSH_TEST_ERROR = message;
      await assert.rejects(probeRemoteSshHost(host), { message: `${message}\n` });
      await assert.rejects(executeRemoteSshTask({ id: 'test', name: 'test' }, {
        host, harnessType: 'pi-agent', timeout: 5_000,
      }), { message: `${message}\n` });
    }
    // Capture the real command and stdin for both initial and resumed Windows turns.
    const capture = path.join(dir, 'capture.json');
    await writeFile(ssh, `#!/usr/bin/env node
const fs = require('node:fs');
const command = process.argv.at(-1);
if (command.startsWith('bash')) {
  console.error("'bash' is not recognized");
  process.exit(1);
}
const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ script, stdin: fs.readFileSync(0, 'utf8') }));
console.log('ok');
`);
    const prompt = '中文 "one -> two" & | < > % !\n--not-an-option\nC:\\Code\\';
    const freshDirectories: string[] = [];
    for (const resumeSessionId of [undefined, undefined, '$HOME/.pi/agent/sessions/existing']) {
      const result = await executeRemoteSshTask({ id: 'test', name: 'test', description: prompt }, {
        host, harnessType: 'pi-agent', timeout: 5_000,
        resumeSessionId, continuationMessage: prompt,
      });
      const captured = JSON.parse(await readFile(capture, 'utf8'));
      assert.ok(captured.stdin.includes(prompt));
      assert.ok(captured.script.includes(result.sessionId!), 'returned directory must match the PowerShell command');
      if (resumeSessionId) assert.equal(result.sessionId, resumeSessionId);
      else freshDirectories.push(result.sessionId!);
      if (resumeSessionId) assert.equal(captured.stdin, prompt);
      assert.doesNotMatch(captured.script, /ReadToEnd|\$prompt/);
      assert.match(captured.script, resumeSessionId ? /--continue$/ : /--session-dir .*$/);
    }
    assert.notEqual(freshDirectories[0], freshDirectories[1]);
    console.log('Remote SSH Windows fallback checks passed');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalError === undefined) delete process.env.SSH_TEST_ERROR;
    else process.env.SSH_TEST_ERROR = originalError;
    await rm(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
