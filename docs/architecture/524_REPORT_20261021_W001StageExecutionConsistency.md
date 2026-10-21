---
doc_type: REPORT
doc_status: verified_isolated
---

# W001 stage execution consistency

This is the second deliverable, separate from root-cause fix `f91cb2e`. Baseline `2c3f605` preserved the DEMAG investigation. A's red/green evidence remains in `docs/evidence/stage-w001/a`.

The permanent constraint is [W001](../wires/W001-stage-execution-contract-consistency.md). Its entry is `npm run check:wire-w001`, required by build, workflow regression and the isolated PostgreSQL runner. It combines a private TypeScript contract, one local dispatch boundary, fresh ledger observation, registered AST callsites, behavioral tests and isolated source mutants.

## Changes and preserved boundaries

- `acpx/stage-execution-request.ts`: immutable current stage, permission/output validation and drift rejection.
- `acpx/stage-authority.ts`: observation of existing execution claim/revision/TaskRun, review claim or conversation reservation, candidates and fixed conflict input fingerprint.
- `acpx/stage-harness-dispatch.ts`: one execute/resume boundary with the same current task. Ordinary fresh chat and native continuation remain compatible.
- `runner-harness.ts`: one prepared context replaces duplicate execute/resume literals; capture before preparation, seal after preparation, recheck before dispatch.
- `scripts/check-stage-execution-wire*`, mutation runner and tests: machine checks and mandatory registrations.

Task Graph retains dispatch approval, stage transitions, budgets, input binding and Writer proof. Sandbox Manager retains lifecycle; the Bubblewrap renderer retains mount interpretation. No new permission approval, lifecycle controller, recovery state or prompt framework was added. Artifact consumption still uses its existing identity/CAS/Writer checks.

## Review and verification

The independent implementation review found that ordinary chat with a cleared invalid Session ID could receive stale continuation text on fresh execute. This was corrected and a compatibility test added. The review found no additional concrete permission regression.

The gate rejects 20 AST counterexamples. Actual temporary dispatcher mutants reintroduce the old Resume input, change permissions/output/candidate, and remove validation; each must fail for its expected behavioral reason. A real disposable ledger test changes the candidate between observations and rejects stale TaskRun/replaced claim without advancing outcome or budgets.

Integration covers resumed conflict repair, readonly source writes, bound resolution output, integration advancement, independent review, successor release, Manager/native Session continuation and normal/read-only material interaction. Exact commands, results and scope limits are in [B evidence](../evidence/stage-w001/b/README.md).

GitNexus impact lookup was attempted for the shared Runner. Its existing index failed with a LadybugDB readonly shadow-replay error. No index rebuild or repair was performed against the shared workspace. Actual callsites were traced with source navigation and are enumerated in the Wire; no successful graph-index impact result is claimed.

No service was restarted or deployed. No production DEMAG Ticket, approval snapshot, runtime ledger, recovery budget or permissions were changed. Production recovery requires separate user authorization.

## Final review compatibility correction

Fixed review of `3089dcc` found one P2 ordinary-chat regression: nongraph native Resume discarded existing per-turn Project Capabilities and long-file instructions. Restore those existing additions in the continuation selector through the same dispatcher. Graph requests still always select their sealed stage prompt. No new prompt policy, authorization, mount or state is introduced.

The new regression fails before this fix at `Ordinary Resume retains current capability instructions`, then passes with capability and current offending-file assertions. The W001 gate, type check and isolated `task-graph-conflict-continuation` + `task-graph-sandbox-manager` suites pass. Evidence is in `docs/evidence/stage-w001/p2`. This is an append-only correction after the two independent A/B commits.
