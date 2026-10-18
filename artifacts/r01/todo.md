# R01 attempt todo

Playbook: Feature. Sole writer: assigned R01 implementer.

## Original steps, verbatim

### Feature

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (default in poteto-mode's Models section) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. **Give every file-writing delegate its own worktree** (spawn it with `isolation: "worktree"`, or hand it an exclusive branch), and do not write files or run a suite in a worktree a delegate still holds. Fencing a file in the brief's prose is not a lock (**principle-separate-before-serializing-shared-state**). Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline. That owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries. Spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.

## Project substitutions and checkpoint

- Step 1 completed by read-only reader_flow explainer using how and GitNexus. Step 2 not entered because complete representative-page material is missing.
- Step 3 blocking first steps: verify fixed Git objects, real image/truth, OCR runtime, and GitNexus.
- Step 3 independent workstreams: n/a, one ticket and one writer; platform acceptance is separate.
- Step 3 shared mutable state: original repositories and Python environments are read-only; no database work.
- Step 3 smallest safe decomposition: first prove prerequisites, then reuse R02, then v2 export and behavior verification.
- Step 4 replaced by assigned implementer writing in this workspace. No extra writer or worktree.
- Step 6 replaced by append-only platform checkpoints. No add/commit/merge.
- Step 7 applies only if design is contested.
- Step 8 replaced by ticket checks, evidence and structured report to platform.
- Independent acceptance is owned by platform tester, not self-review.

## Observed gates

- [x] Loaded frozen Spec and Reader public raw contract.
- [x] Playbook anchor check passed.
- [x] GitNexus indexed workspace with index-only mode.
- [x] R02 objects present; two commits not in baseline.
- [x] Model HEAD matches approved bc3f7069; untracked directories excluded.
- [x] Real CPU OCR, script subprocess and HTTP ASGI upload executed with the actual image.
- [x] R02 applied after symbol impact analysis; all 14 files exactly match source objects; no integration SHA has been created.
- [ ] Implement v2 field definition, observations, offline package and v1 compatibility.
- [x] Ran exact required ticket behavior command: 2 passed, 2 failed. A01 Reader-only partial, A04 failed, A05/A18 Reader replay partial. Joint Model behavior remains unverified.
- [ ] Platform independent acceptance.

## Gate outcome

BLOCKED: missing_business_material. No registered sample currently combines an available original and complete full-page reviewed truth. Manifest inventory is material-inventory.json.

- Step 2 skip: frozen page scope and physical identities require complete reviewed material before v2 architecture/definition is finalized. No arena or architect design panel was run.
- Step 4 completed only for exact R02 source reuse and behavior-gate tests, not the new v2 feature.
- Step 5 partial: real Reader HTTP/script and offline v1 replay executed; two new requirements fail. No Model API/GET/reopen/browser checks executed.
- Step 6 skip: Git metadata is read-only; coordinator owns checkpoint and integration. Integration SHA remains pending.
- Step 7 skip: no v2 design was finalized; no contested design review entered.
- Step 8 report-only project substitution; independent platform acceptance still pending and not replaced by author testing.
- No project verify skill exists in the supplied workspace; used the exact ticket entry.
- No DB accessed, extra source tree written, dependency installed, or new environment created. PaddleOCR downloaded model assets into isolated runtime HOME.
