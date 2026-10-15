import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/** flock is held by a child for the whole merge, including verification. */
export async function withRepositoryLock<T>(repository: string, action: () => Promise<T>): Promise<T> {
  const canonical = await realpath(repository);
  const root = path.join(path.dirname(canonical), '.agent-platform-task-graph-locks');
  await mkdir(root, { recursive: true });
  const name = createHash('sha256').update(canonical).digest('hex');
  const child = spawn('flock', ['-x', path.join(root, name), 'sh', '-c', 'printf "READY\\n"; read release'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('READY\n')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`Repository lock exited before acquisition (${code})`)));
    });
    return await action();
  } finally {
    child.stdin.end('\n');
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}
