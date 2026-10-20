# S01-A evidence

This step extracts preparation and the Bubblewrap renderer. It changes no lifecycle or permission policy, so its gate is baseline equivalence rather than a fabricated behavioral failure.

The parity suite loads the original compiler from fixed commit `1054a5e` with `git show`, resolves its existing helpers relative to the original module, and compares command, ordered argv and thrown error name/message for 20 fixtures. The original compiler exists only in test memory. There is no second production compiler.

- `baseline-bubblewrap.log`: existing native Bubblewrap test before extraction, exit 0. The compiler emitted a tsconfig-paths baseUrl warning; the test passed.
- `baseline-parity.log`: original fixed compiler exercised in actual Bubblewrap, including restricted/enabled network namespace identity and project Python venv invocation.
- `green-parity.log`: extracted legacy wrapper and direct preparation/renderer compared with the original compiler, plus actual Bubblewrap probes.
- `green-bubblewrap.log`: existing filesystem, symlink, read-only and workspace escape probes, exit 0.
- `green-codex-package.log`: actual packaged Codex companion executable remains reachable, exit 0.
- `green-isolated-runtime.log`: `node scripts/test-task-graph-postgres.mjs task-graph-sandbox task-graph-output-runtime task-graph-runtime-pinning task-graph-skill-runtime`, exit 0. The runner creates and drops a fresh PostgreSQL schema. Fixtures exercise both Codex and Kimi legacy launch behavior, isolated outputs, immutable runtime pins and the complete approved skill package in strict Bubblewrap.
- `green-tsc.log`: `npx tsc --noEmit`, exit 0. Empty log means no diagnostics.
- `baseline-long-files.log`, `green-long-files.log`: long file guard before and after extraction, exit 0.

Fixture environment credentials are fixed fake values. Logs contain no host credentials or production ticket state. No deployment or production ticket continuation occurred.
