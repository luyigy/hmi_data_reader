---
extends: feature, bug-fix, refactoring, session-pickup
when: Implement, repair, refactor, or resume an approved Agent Platform task-graph ticket in this repository using poteto-mode.
---

# Agent Platform ticket adaptation

Scope: the approved ticket and frozen Spec. The task graph owns dispatch, workspace ownership, acceptance, and the completion ledger. poteto-mode supplies the engineering steps inside this ticket. User and repository rules take precedence. Load the installed poteto-mode SKILL.md and the Codex tool mapping first, then the matched bundled playbook and this adaptation.

## Start and record

Choose Feature for changed behavior, Bug fix for a reproduced defect, Refactoring for behavior-preserving structure, or Session pickup for a resumed attempt. Open other playbooks only when their triggers apply. Copy the matched bundled steps verbatim into the local todo list, then apply the anchored changes below. Keep every skipped step with its reason. Record the skill/playbook paths and versions or content hashes actually read.

Keep todo.md and decision evidence in the ticket's platform-managed results area, so they are archived with the attempt. These files record work inside the attempt; they do not dispatch another task or become a PLAN/HANDOVER workflow. Read prior task receipts and actual Git state on resume. Preserve the existing project environment and declare extra repository access through the approved route.

## Platform changes to bundled steps

- **Replace** "Delegate code-writing to a subagent" with: the platform-assigned implementation Agent owns this ticket's diff in its already allocated task workspace. This explicit project rule replaces Feature step 4's mandatory extra implementation delegate. Independent acceptance is performed by the platform-assigned tester in a separate Session. Use read-only helpers for exploration or design when the relevant skill requires them. Additional file-writing agents require an explicitly approved disjoint execution scope; do not create a second writer or another worktree merely to satisfy the bundled delegation step.
- **Replace** "Delegate implementation to a subagent" with: the platform-assigned implementation Agent writes the Bug fix change after reproducing and tracing the mechanism. Keep platform independent acceptance and the same-surface failing/passing evidence.
- **Replace** "Delegate the mechanical edits to a subagent" with: the assigned implementation Agent makes the Refactoring edits in the ticket workspace, with behavior characterization and caller accounting. Independent platform acceptance remains required.
- **Replace** "Rebase into small, ordered commits. Stack follow-ups." with: prepare small, ordered, verifiable changes for platform-controlled checkpoint commits. The implementation Agent leaves add/commit/merge to the coordinator when the task prompt assigns that responsibility. Preserve all commits already visible to other Agents, approvals or the execution ledger.
- **Replace** "Rebase into small ordered commits." with: separate subtraction, reshape and necessary follow-up changes into verifiable units for platform-controlled append-only checkpoints. Follow the task prompt for who creates commits; never rewrite existing history.
- **Replace** "Run **Opening a PR**." with: complete the ticket's required checks, review the diff and report the changed files, available checkpoint identity, evidence, unresolved items and structured implementation outcome to the platform. The platform performs the approved integration and independent acceptance. Opening, pushing, merging or shipping a PR is a separate authorized action and is not a prerequisite for completing this ticket.
- **In** "migrate every caller and delete the old API in the same wave" preserve the HMI Spec's explicit historical replay boundary. Migrate all callers in the approved scope; retire a page's repeated editable path only after its compatibility and save/reopen acceptance passes. Immutable old evidence and version replay are required product behavior, not abandoned duplicate editing APIs.
- **In** "Write the throughput checkpoint as four todo items." identify the existing task workspace's sole writer, relevant read-only inputs, actual shared state and smallest safe implementation scope. These items describe work inside the ticket and do not create another task queue.
- **In** "Read the project checkpoint first" use the platform attempt/commit, archived results, prior decisions and frozen Spec as the authoritative task checkpoint. A pstack resume note may index these records but cannot replace the execution ledger or approval history. Missing material is an explicit blocker, not a reason to repeat completed work or create a fresh task.

## Keep the applicable quality steps

Read existing code before changing it. Name the data shape and owners. Apply how, architect, tdd, no-comments, deslop, blast-radius or interrogate at their actual triggers, following the installed skill and host tool mapping. A repeated failure calls for observed root cause, not speculative guards. An independent review requirement stays open if the required reviewer cannot run; passing tests or the author's own review do not fill that gate.

Verification follows the approved acceptance IDs and the actual surface: Reader image/contract behavior, Model API/GET, or browser save/reopen. An executed pytest or build is only its own evidence. Preserve source provenance, the current attempt's revision identities, and decisive failing/passing output. The platform-designated acceptance Session must independently inspect the final artifact and evidence.

Before returning, give the platform changed files and any already-created checkpoint identity, performed checks, evidence paths, playbook/step completion and exact blockers. Return delivered only when the ticket's implementation is delivered; blocked is not delivery. Match the existing platform implementation result contract rather than inventing a new completion marker. Further tickets, deployments, destructive cleanup and wider permissions remain subject to the existing platform approval flow.
