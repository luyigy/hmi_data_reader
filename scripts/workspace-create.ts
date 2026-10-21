import path from 'node:path';
import { createWorktree } from '../src/lib/git-worktree';

async function main() {
  const [repository, workId, purpose = 'development', baseRef] = process.argv.slice(2);
  if (!repository || !workId || !['development', 'baselines'].includes(purpose) || process.argv.length > 6) throw new Error('Usage: workspace:create -- <repository> <stable-work-id> [development|baselines] [base-ref]');
  if (purpose !== 'development' && purpose !== 'baselines') throw new Error('Invalid purpose');
  console.log(await createWorktree(path.resolve(repository), workId, baseRef, purpose));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
