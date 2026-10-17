import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Task-controlled hooks and attributes must not turn platform Git steps into host shell execution. */
export async function graphGit(cwd: string, ...args: string[]): Promise<string> {
  const options = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  try {
    const { stdout } = await exec('git', [...options, 'config', '--name-only', '--get-regexp', '^filter[.].*[.](clean|process|required)$'], { cwd, maxBuffer: 1024 * 1024 });
    for (const key of stdout.trim().split('\n').filter(Boolean)) {
      if (!/^filter\.[A-Za-z0-9_.-]+\.(clean|process|required)$/.test(key)) throw new Error('Unsupported Git filter configuration');
      options.push('-c', key + (key.endsWith('.required') ? '=false' : '='));
    }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error; }
  const { stdout } = await exec('git', [...options, ...args], { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return stdout.trimEnd();
}
