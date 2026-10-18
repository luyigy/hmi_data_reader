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

## Resume at checkpoint 1172836

The current playbook is Session pickup. The Feature record above is inherited evidence, not work repeated in this session.

### Original Session pickup steps, verbatim

### Session pickup

**You own the resume point. Read the prior trail, don't redo it.**

1. Read the project checkpoint first using [Resume storage](../references/resume-storage.md). A successful read gives the note and artifacts without requiring a path from the previous session. If the pointer is missing, locate the prior trail through a local transcript under Claude Code's per-project transcripts directory at `~/.claude/projects/<encoded-cwd>/*.jsonl` (where `<encoded-cwd>` is the workspace cwd with `/` → `-`. Do not glob across other directories under `~/.claude/projects/`, that crosses workspace boundaries and reads private chats from unrelated projects), a cloud-agent URL, or a pushed branch. An unavailable or incomplete checkpoint needs diagnosis rather than a silent fallback. For transcript fallback, read the metadata overview and last messages first, then scan back for the decision points. Parse a long transcript in a subagent and keep the reduced timeline in the main thread (the **principle-guard-the-context-window** skill).
2. Reconstruct operational state. The branch and worktree, what already landed (`git log`, `git diff` against the base), the open todos, the decisions made. Use the prior trail to recover progress. For claims about human rulings, follow [Claims about human decisions](../../why/references/epistemics.md#claims-about-human-decisions). An agent summary is not the original ruling.
3. Diff done vs pending. Compare what shipped against what was planned, name the resume point, do not re-run the prior repro or redo completed work. Recheck claims that affect the remaining work without repeating completed investigations. Read artifacts linked by the resume note, including requested questions or checklists.
4. Route the remaining work to the matching playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. The pickup playbook ends here. The routed playbook owns the rest.
5. Verify the inherited claims against the original goal on the real artifact (the **principle-prove-it-works** skill). A passing prior self-report is not the proof.

**Reply:** where the prior agent stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.

### Actual project adaptation and execution

- [x] Step 1 uses the platform checkpoint 1172836fe6f044b32e9709ea6957dc4c63f8c8ed and the existing artifacts/r01 report, todo, material inventory and source verification. The project substitution owns checkpoint storage. No Git metadata writes or separate pstack resume store.
- [x] Step 2 reconstructed the clean inherited worktree, R02 reuse, open v2 requirements and fixed Model HEAD bc3f7069f6bf973c04ffb9fde3bbb3f21c18bdd0. Extra repository untracked files remain excluded.
- [x] Step 3 compared inherited results with current inputs. The material index checkedAt 2026-10-18T10:29:33.848Z has no items. Fixed input manifest 65c17a0d1a33375be049b78273960fa6e165270a5455c47878f5ff1705dba274 has inputs=[].
- [x] Step 4 routed back to the unfinished Feature prerequisites. User permission for model-generated annotations is accepted. Human annotation is not a new prerequisite. A read-only Feishu table probe failed with config/not_configured. An existing local VLM did receive the actual representative image and returned candidates.
- [x] Step 5 checked actual behavior and the VLM response. The candidate contains five out-of-image bboxes and wrong physical stage numbering. It is not a valid frozen full-page truth. The exact ticket behavior command ran again and failed on the inherited missing v2 behavior.
- [ ] Feature implementation remains blocked on usable representative-page material and the configured material retrieval environment. No v2 schema, package or behavior has been declared delivered.
- [ ] Independent platform acceptance remains pending. Self-testing does not fill that gate.

Evidence: resume-probes.json, resume-vlm.json, resume-ticket-behavior.log, resume-read-versions.json. The playbook anchor check ran successfully again. Skill and playbook SHA-256 values are recorded in resume-read-versions.json.

The throughput checkpoint remains unchanged: one writer; primary worktree only; extra source and Python environments read-only; no database; material validation before freezing page identities or fields. No code symbols changed, so no new symbol impact analysis is required. No PR, dispatch, Git mutation, dependency installation, or source-repository write.
