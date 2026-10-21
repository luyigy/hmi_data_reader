# W001: Stage Execution Contract Consistency

Status: enforced for the currently supported local Task Graph stage dispatches.

## Invariant

First start and native Session Resume must dispatch the same validated current Stage Execution Request. Session history supplies context; it cannot replace the current stage task, source protection or output requirements.

This is a manual Gardening result. DEMAG's observed failure supplied the counterexample; the reusable contract, registered source boundary and mandatory negative tests make this a Wire. No Gardening scheduler or new persistent state was introduced.

## Machine entry

```sh
npm run check:wire-w001
```

This runs the TypeScript AST boundary gate, its counterexamples, immutable contract tests, actual dispatcher behavior tests and five isolated source mutants. Any failed check exits nonzero. The gate is required by `npm run build` through `prebuild`, `npm run test:task-graph-workflow`, and the PostgreSQL regression runner before it creates its disposable schema. `task-graph-stage-authority` is also registered in that runner's default suites.

```sh
npm run test:task-graph-postgres -- task-graph-stage-authority task-graph-conflict-continuation task-graph-sandbox-manager task-graph-review-repair task-graph-interactive-conversation
npx tsc --noEmit --pretty false
```

The complete PostgreSQL command tests existing Writer/CAS, real Bubblewrap protection, native-protocol fixtures and stage transitions. It uses isolated schemas and temporary repositories. It does not authorize production Ticket recovery.

## Ownership and actual callsites

| Entry | Current stage task owner | Dispatch |
| --- | --- | --- |
| Implementation, result collection, conflict repair | `task-graph/coordinator.ts` | One registered `executeAcpxTaskRun` call |
| Architecture | `architecture-review.ts` through `review-result.ts` | Shared registered review collector |
| Acceptance and review result recollection | `coordinator.ts` through `review-result.ts` | Same collector; feedback remains in current description |
| Historical/read-only material followup | `conversation-followup.ts` | One registered conversation call |
| Native invalid-Session fallback | `acpx/continuation-retry.ts`, Runner participant | Same local finalization; only Session selection changes |
| Session selection | `conversation-session.ts` | Identity/history only; no independent task message parameter |

`runner-harness.ts` prepares existing resources and final instructions, creates `StageExecutionRequest`, and passes it to `executePreparedStageHarness`. The dispatcher validates fresh authority and the actual context before its single execute/resume pair. Both branches get the identical sealed prompt. Native Session IDs, callbacks, process registration and Manager lifecycle remain on their existing path.

`StageExecutionRequest` has a private constructor, cloned/frozen input and a canonical digest. It binds phase, candidate, existing execution/review/conversation ownership, TaskRun, supplied input IDs, immutable dispatch/conflict fingerprint, working directory, permissions, readonly/writable mounts, output bindings and prepared upstream manifest. `captureStageAuthority` reads existing ledger authority before preparation and again before launch. It neither acquires a claim nor changes revision or budgets.

The first observation is checked against the later authoritative observation, rather than comparing two copies of an already stale candidate. Existing binding code still authorizes material inputs and resource plans. W001 checks consistency after capture; it does not independently approve the initial mount plan or material list.

## Source and output policy

Conflict repair protects the existing source Worktree and uses a separate writable runtime. Review retains its existing readonly sources. Readonly conversations retain `read-only` mode. A broader writable mount cannot overlap protected source. Existing renderer-approved output aliases below readonly source are preserved only when backed by the current isolated output directory; replacing the source root is rejected.

Private sandbox temporary files remain possible. W001 does not claim that every filesystem write must be inside the output directory. Platform-applied resolution artifacts must come from the bound current output. The existing conflict input hashes, candidate, claim/revision and Writer-exit checks remain authoritative before application, and are unchanged.

## Counterexamples that must fail

| Counterexample | Required detection |
| --- | --- |
| Resume sends historical `participant.continuationMessage` | AST gate and actual dispatcher behavior assertion |
| Current task and Resume message diverge | Shared expression and behavioral equality |
| Candidate/claim/revision/input identity changes during preparation | Fresh authority comparison before dispatch |
| Prepared input manifest, network/permissions, mounts or output changes | Runtime comparison; protected-source validation |
| Stage changes without building a new current request | Authority mismatch |
| Graph request has no sealed request | Dispatcher refuses before adapter invocation |
| New direct/aliased Graph producer or direct local adapter call | Registered AST callsite gate |
| Validator removed | Candidate-drift behavior test fails with missing rejection |

The source mutation runner intentionally reintroduces old Resume input, changes permissions, changes output, changes candidate and removes validation in temporary copies of the real dispatcher. It requires a specific behavioral failure, rejects infrastructure/import/compiler failures, and never edits production source. AST tests additionally cover 20 structural counterexamples, including named import aliases, namespace imports and literal element access.

## Limits and maintenance

- Current route validation in `task-graph/launch.ts` requires local implementation and review participants. All registered local stages cross this boundary, regardless of which supported local Harness adapter is selected.
- Ordinary remote SSH, remote-node and Gateway transports were surveyed. They retain the current-input selector correction, but remote filesystem policy is not covered by this local sealed-runtime contract. Enabling remote Graph stages requires an explicit contract extension and equivalent resource evidence.
- AST analysis covers registered source files and visible import/call expressions. Arbitrary reflection, dynamic require, runtime monkey-patching and arbitrary multi-hop aliases are not proven. A changed registered topology requires reviewing and updating the gate, not merely increasing a count.
- W001 checks Runner-to-adapter dispatch, not an external model's interpretation or every future adapter's native serialization. Native-protocol fixture and real sandbox regressions support the currently exercised adapter path. No new production/model acceptance is claimed.
- Runtime consistency is checked immediately before dispatch; existing Writer proof, input binding and recovery CAS still fence later result application. The Wire is neither a replacement authority nor a new state machine.

Evidence: [A regression](../evidence/stage-w001/a/README.md), [B gate and inverse tests](../evidence/stage-w001/b/README.md).
