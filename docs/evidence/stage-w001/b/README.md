# B: W001 evidence

Baseline: A commit `f91cb2e`, following original baseline `2c3f605`. The isolated branch is `fix/stage-execution-w001-20261021`.

## Required gate

```sh
npm run check:wire-w001
```

`gate.log` records the real source topology passing, 20 AST counterexamples rejected, immutable contract and dispatcher behavior passing, and five actual source mutants killed. Each mutant process exits 1 for the expected failure. The mutation runner checks failure identity and disallows module/compiler/infrastructure failures; source copies are temporary and removed afterward.

The old Resume mutation fails the assertion that the actual adapter argument contains the current finalized task. Permissions and output mutations fail W001 protection before adapter invocation. Candidate mutation fails fresh authority comparison. Validation removal makes the expected candidate-drift rejection disappear, which fails the regression. These negative checks run on every gate invocation.

## Integration and state evidence

```sh
npm run test:task-graph-postgres -- task-graph-conflict-continuation task-graph-sandbox-manager task-graph-review-repair task-graph-interactive-conversation
```

`integration.log` is the passing four-suite run. It records:

- Waiting conflict with native Session and concurrent integration advancement: killed repair worker, new bound output, merge preserving both deliveries, independent architecture/acceptance and successor once.
- Manager/native protocol fixture: first implementation and material continuation use the same native Session; node reaches passed, repairAttempts stays 0. A living nonce descendant still prevents Writer-exited proof after root closes.
- Review repair pickup refuses a writer that has not proven exit, then follows the existing targeted repair/independent review path.
- Two repositories run concurrently. A normal waiting implementation receives materials through its original native Session; delivery moves from attention/waiting_for_user to integrated/architecture, then verification releases the successor. Completed delivery follows readonly conversation and preserves fixed evidence. Original retry/backoff assertions pass.

```sh
npm run test:task-graph-postgres -- task-graph-stage-authority task-graph-conflict-continuation
```

`final-integration.log` records the final fingerprint/manifest additions. The real disposable ledger retains authority until a deliberate candidate change, rejects that drift and a different TaskRun/replaced claim, then reruns the full resumed-conflict case successfully. The fixture initializes progress through the existing checkpoint operation; an earlier incomplete fixture setup lacked progress and was corrected without changing production behavior or assertions.

```sh
npm run test:task-graph-workflow
npx tsc --noEmit --pretty false
npm run check:long-files
```

`workflow.log` records the mandatory gate followed by workflow/static validation. `checks.json` records process exit codes for final checks; `long-files.log` records the length guard. No full production build, deployment or new live-model acceptance was performed.

These integration tests use disposable schemas, temporary repositories and model/native-protocol fixtures, with real Bubblewrap filesystem tests. Production route state was not rewritten. Full applicability and dynamic-path limits are in [W001](../../../wires/W001-stage-execution-contract-consistency.md).
