import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const sourcePath = path.resolve('src/lib/acpx/stage-harness-dispatch.ts');
const original = readFileSync(sourcePath, 'utf8');
const root = mkdtempSync(path.join(os.tmpdir(), 'w001-mutants-'));
const env = { ...process.env, TS_NODE_BASEURL: '.',
  TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'commonjs', moduleResolution: 'node' }) };
const replace = (from, to) => {
  assert(original.includes(from), 'Mutation anchor changed; review this counterexample');
  return original.replace(from, to);
};
const variants = [
  ['old-resume-input', replace('continuationMessage: message', 'continuationMessage: participant.continuationMessage || message'), /Resume must send the current finalized stage/],
  ['permission-drift', replace('const runtime = stageRuntimeContract(context);', "context.extraWritableRoots = [...(context.extraWritableRoots || []), '/source'];\n    const runtime = stageRuntimeContract(context);"), /W001.*writable root overlaps/],
  ['output-drift', replace('const runtime = stageRuntimeContract(context);', "context.taskEnvironment!.AP_GRAPH_OUTPUT_DIR = '/outputs/changed';\n    const runtime = stageRuntimeContract(context);"), /W001.*output directory lacks/],
  ['candidate-drift', replace('stageRequest.assertMatches({ authority, runtime });', "if (authority.kind === 'execution') authority = { ...authority, candidateCommit: 'f'.repeat(40) };\n    stageRequest.assertMatches({ authority, runtime });"), /W001.*authority drift/],
  ['validation-bypass', replace('stageRequest.assertMatches({ authority, runtime });', 'void runtime;'), /Missing expected rejection.*candidate drift/s],
];
try {
  for (const [name, source, expected] of variants) {
    const filename = path.join(root, `${name}.ts`);
    // Keep the actual dispatcher and real dependencies; only named defects are introduced into this temporary copy.
    const resolved = source.replace(/from '(\.\.?\/[^']+)'/g, (_, specifier) => `from '${path.resolve(path.dirname(sourcePath), specifier)}'`);
    writeFileSync(filename, resolved);
    const result = spawnSync(process.execPath, ['-r', path.resolve('node_modules/ts-node/register/transpile-only'),
      '-r', path.resolve('node_modules/tsconfig-paths/register'), 'tests/stage-harness-dispatch.test.ts'], {
      env: { ...env, W001_DISPATCH_MODULE: filename }, encoding: 'utf8', timeout: 30000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert(!result.error, `Mutation infrastructure failed: ${result.error}`);
    assert(result.status !== 0, `W001 survived ${name}`);
    assert.match(output, expected, `Wrong failure for ${name}: ${output}`);
    assert.doesNotMatch(output, /Cannot find module|SyntaxError|Unable to compile/);
    console.log(JSON.stringify({ wire: 'W001', mutant: name, exit: result.status, matchedFailure: output.match(expected)?.[0] }));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
