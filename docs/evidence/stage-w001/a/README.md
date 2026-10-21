# A: root-cause regression

Baseline: `2c3f605`. No production service or Ticket was restarted/resumed.

`demag-failure.json` preserves the actual failed Resume stage tail, source identity, readonly runtime and output protocol. The full original snapshot is retained privately with its SHA. The prepared full description was not persisted by the old system; its stage-specific protocol is reconstructed and explicitly marked, not presented as an observed full payload.

Red: extend the existing isolated conflict/restart scenario with a real prior native Session. Observe the actual adapter Resume argument. On baseline the assertion `DEMAG replay: current stage missing from actual Resume input` fails. This exercises the original fork, not a fake stale string passed to a pure helper.

Green command:

```sh
npm run test:task-graph-postgres -- task-graph-conflict-continuation task-graph-sandbox-manager task-graph-review-repair
```

The scratch-schema conflict case preserves both deliveries after concurrent integration advanced, kills the earlier repair worker, resumes the same Session, and runs actual Bubblewrap. Source file writes and a wrongly placed resolution in readonly source fail; the current approved output succeeds. The platform consumes the resolution, applies its existing input/claim/writer checks, rechecks integration, completes architecture/acceptance and releases the successor once. Existing repair/platform budgets are asserted without relaxation.

The sandbox permits temporary files in its private `/tmp`; this test does not claim all writes outside AP_GRAPH_OUTPUT_DIR are impossible. Only artifacts from the current bound output receipt can be applied by the platform. A diagnostic test initially incorrectly expected private `/tmp` to be globally readonly; the probe was corrected to exercise a protected source path, without changing sandbox permissions.

The fake model adapter is an integration-test boundary. Native model semantics and production acceptance are not claimed. The companion Manager scenario uses a real native-protocol fixture through Bubblewrap and checks surviving nonce descendants.

This is an ordinary root-cause regression. It is not yet the permanent W001 gate.
