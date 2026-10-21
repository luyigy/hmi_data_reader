import { execFileSync } from 'node:child_process';

const env = { ...process.env, TS_NODE_BASEURL: '.',
  TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'commonjs', moduleResolution: 'node' }) };
for (const file of ['scripts/check-stage-execution-wire.ts', 'tests/stage-execution-wire-ast.test.ts',
  'tests/stage-execution-request.test.ts', 'tests/stage-harness-dispatch.test.ts']) {
  execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', file], { env, stdio: 'inherit' });
}
execFileSync(process.execPath, ['scripts/test-stage-execution-wire-mutants.mjs'], { env, stdio: 'inherit' });
