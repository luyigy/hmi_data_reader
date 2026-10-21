import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Task-controlled hooks and attributes must not turn platform Git steps into host shell execution. */
async function graphGitOptions(cwd: string) {
  const options = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  try {
    const { stdout } = await exec('git', [...options, 'config', '--name-only', '--get-regexp', '^(filter[.].*[.](clean|smudge|process|required)|merge[.].*[.]driver|diff[.].*[.](command|textconv))$'], { cwd, maxBuffer: 1024 * 1024 });
    for (const key of stdout.trim().split('\n').filter(Boolean)) {
      if (!/^(filter\.[A-Za-z0-9_.-]+\.(clean|smudge|process|required)|merge\.[A-Za-z0-9_.-]+\.driver|diff\.[A-Za-z0-9_.-]+\.(command|textconv))$/.test(key)) throw new Error('Unsupported Git driver configuration');
      options.push('-c', key + (key.endsWith('.required') || key.endsWith('.driver') ? '=false' : '='));
    }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error; }
  return options;
}

export async function graphGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...await graphGitOptions(cwd), ...args], { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return stdout.trimEnd();
}

/** Preserve the legacy JSON fingerprint [trimmed stdout, suffix] without buffering a potentially huge binary diff. */
export async function graphGitJsonPairDigest(cwd: string, args: string[], suffix: unknown): Promise<string> {
  const options = await graphGitOptions(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...options, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256').update('["');
    let trimmed = hash.copy(), stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const body = chunk.trimEnd();
      if (body.length) { hash.update(JSON.stringify(body).slice(1, -1)); trimmed = hash.copy(); }
      hash.update(JSON.stringify(chunk.slice(body.length)).slice(1, -1));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`Git fingerprint failed (${code}): ${stderr}`));
      else resolve(trimmed.update('",' + JSON.stringify(suffix) + ']').digest('hex'));
    });
  });
}
