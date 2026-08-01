import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER = '# agent-platform append-only ref guard v3';
const LEGACY_MARKERS = [
  '# agent-platform append-only ref guard v1',
  '# agent-platform append-only ref guard v2',
];
const VALIDATOR_BUNDLE_SOURCE = path.resolve(
  process.cwd(),
  'src/lib/scheduled-jobs/generated/workflow-validator.cjs',
);
const hook = () => `#!/bin/sh
${MARKER}
[ "$1" = prepared ] || exit 0
protected_refs="$(git rev-parse --git-path agent-platform/append-only-refs)" || exit 1
workflow_contracts="$(git rev-parse --git-path agent-platform/workflow-contracts)" || exit 1
validator="$(git rev-parse --git-path agent-platform/workflow-validator.cjs)" || exit 1
[ -f "$protected_refs" ] || exit 0
batch="$(mktemp "\${TMPDIR:-/tmp}/agent-platform-workflow.XXXXXX")" || exit 1
changed="$batch.changed"
output="$batch.output"
trap 'rm -f "$batch" "$changed" "$output"' EXIT HUP INT TERM

while read -r old new ref
do
  grep -Fqx "$ref" "$protected_refs" || continue
  case "$old" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000)
      old="$(git rev-parse --verify "$ref^{commit}" 2>/dev/null)" || continue
      ;;
  esac
  case "$new" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000)
      echo "Agent Platform blocked deletion of append-only $ref." >&2
      exit 1
      ;;
    *) git merge-base --is-ancestor "$old" "$new" || {
      echo "Agent Platform blocked non-fast-forward update of $ref ($old -> $new)." >&2
      echo "Create a new commit instead; monitored workflow history is append-only." >&2
      exit 1
    } ;;
  esac
  contract_path=""
  # Pure-shell lookup: the hook must not depend on awk/sed, which are not
  # guaranteed to exist in minimal Agent environments.
  if [ -f "$workflow_contracts" ]; then
    while IFS="$(printf '\t')" read -r mapped_ref mapped_path _
    do
      [ "$mapped_ref" = "$ref" ] && contract_path="$mapped_path"
    done < "$workflow_contracts"
  fi
  if [ -z "$contract_path" ]; then
    # A missing contract registration is a platform-side configuration gap,
    # not a document error; warn and allow instead of freezing all commits.
    echo "Agent Platform workflow contract is not registered for $ref; commit allowed WITHOUT validation." >&2
    continue
  fi
  git -c core.quotepath=false diff --name-only --diff-filter=AMR "$old" "$new" -- '*.md' > "$changed" || exit 1
  while IFS= read -r file
  do
    case "$file" in
      [0-9]*_PLAN_*.md|[0-9]*_HANDOVER_*.md|*/[0-9]*_PLAN_*.md|*/[0-9]*_HANDOVER_*.md)
        printf '%s\t%s\t%s\t%s\n' "$old" "$new" "$contract_path" "$file" >> "$batch"
        ;;
    esac
  done < "$changed"
done
if [ -s "$batch" ]; then
  node "$validator" --hook-batch "$batch" >"$output" 2>&1
  validator_status=$?
  cat "$output" >&2
  # Only a genuine document validation failure (signalled by the marker) rejects
  # the commit. Validator runtime failures (exit 2, node crash, missing
  # dependencies) degrade to a warning so infrastructure outages cannot freeze
  # all commits.
  if [ "$validator_status" -eq 1 ] && grep -q 'WORKFLOW_DOCUMENT_VALIDATION_FAILED' "$output"; then
    exit 1
  fi
  if [ "$validator_status" -ne 0 ]; then
    echo "Agent Platform workflow validator could not run (exit $validator_status); commit allowed, please repair the validator." >&2
  fi
fi
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
  contractPath = 'docs/workflow/workflow-contract.yaml',
) => {
  if ([ref, contractPath].some((value) => /[\t\r\n]/.test(value))) {
    throw new Error('Git guard ref and contract path must not contain tabs or newlines');
  }
  const [hookPath, refsPath, contractsPath, validatorPath] = await Promise.all([
    gitPath(cwd, signal, 'hooks/reference-transaction'),
    gitPath(cwd, signal, 'agent-platform/append-only-refs'),
    gitPath(cwd, signal, 'agent-platform/workflow-contracts'),
    gitPath(cwd, signal, 'agent-platform/workflow-validator.cjs'),
  ]);
  await Promise.all([
    mkdir(path.dirname(hookPath), { recursive: true }),
    mkdir(path.dirname(refsPath), { recursive: true }),
    mkdir(path.dirname(contractsPath), { recursive: true }),
  ]);

  const hookSource = hook();
  const validatorSource = await readFile(VALIDATOR_BUNDLE_SOURCE);
  const existingHook = await readFile(hookPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (existingHook && !existingHook.includes(MARKER)
    && !LEGACY_MARKERS.some((marker) => existingHook.includes(marker))) {
    throw new Error(`cannot install append-only Git guard over unmanaged hook: ${hookPath}`);
  }
  if (existingHook !== hookSource) {
    await writeFile(hookPath, hookSource, { mode: 0o755 });
  }
  await chmod(hookPath, 0o755);
  const existingValidator = await readFile(validatorPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existingValidator?.equals(validatorSource)) await writeFile(validatorPath, validatorSource);

  const refs = await readFile(refsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!refs.split('\n').includes(ref)) {
    await appendFile(refsPath, `${ref}\n`);
  }
  const contracts = await readFile(contractsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const mapping = `${ref}\t${contractPath}`;
  if (contracts.split('\n').filter((entry) => entry.split('\t')[0] === ref).at(-1) !== mapping) {
    await appendFile(contractsPath, `${mapping}\n`);
  }
};
