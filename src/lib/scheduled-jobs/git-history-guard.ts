import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER = '# agent-platform append-only ref guard v1';
const HOOK = `#!/bin/sh
${MARKER}
[ "$1" = prepared ] || exit 0
protected_refs="$(git rev-parse --git-path agent-platform/append-only-refs)" || exit 1
[ -f "$protected_refs" ] || exit 0

while read -r old new ref
do
  grep -Fqx "$ref" "$protected_refs" || continue
  case "$old" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) continue ;;
  esac
  case "$new" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) ;;
    *) git merge-base --is-ancestor "$old" "$new" && continue ;;
  esac
  echo "Agent Platform blocked non-fast-forward update of $ref ($old -> $new)." >&2
  echo "Create a new commit instead; monitored workflow history is append-only." >&2
  exit 1
done
`;

const gitPath = (cwd: string, signal: AbortSignal, name: string) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', ['rev-parse', '--git-path', name], { cwd, encoding: 'utf8', signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(path.resolve(cwd, stdout.trim()));
    });
  });

export const ensureAppendOnlyGitRef = async (
  cwd: string,
  ref: string,
  signal: AbortSignal,
) => {
  const [hookPath, refsPath] = await Promise.all([
    gitPath(cwd, signal, 'hooks/reference-transaction'),
    gitPath(cwd, signal, 'agent-platform/append-only-refs'),
  ]);
  await Promise.all([
    mkdir(path.dirname(hookPath), { recursive: true }),
    mkdir(path.dirname(refsPath), { recursive: true }),
  ]);

  const existingHook = await readFile(hookPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (existingHook && !existingHook.includes(MARKER)) {
    throw new Error(`cannot install append-only Git guard over unmanaged hook: ${hookPath}`);
  }
  if (!existingHook) {
    await writeFile(hookPath, HOOK, { mode: 0o755 });
  } else {
    await chmod(hookPath, 0o755);
  }

  const refs = await readFile(refsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!refs.split('\n').includes(ref)) {
    await appendFile(refsPath, `${ref}\n`);
  }
};
