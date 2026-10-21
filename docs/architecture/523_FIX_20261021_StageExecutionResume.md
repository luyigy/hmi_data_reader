---
doc_type: FIX
doc_status: verified_isolated
---

# A: stage request survives native Session continuation

The original DEMAG conflict repair prepared an output-based repair description but resumed with the original implementation message. Runner also discarded late-bound input, output and runtime instructions on its Resume branch.

The fix builds the current phase description once. Session lookup returns identity and degraded history only, without another task-message field. After Runner prepares its existing resources, graph execute and Resume receive the same final description. Remote continuation uses the same current-input selector; ordinary chat retains its existing continuation behavior. Task-room history is input within a Graph stage and no longer receives an overriding priority declaration.

Sandbox Manager, mounts, Writer Ownership, claim/revision, conflict artifact validation and budgets remain authoritative and unchanged. No production deployment or DEMAG resume occurred.

Evidence, counterexample and exact test command: [A evidence](../evidence/stage-w001/a/README.md). The second independent deliverable, W001, adds the persistent machine gate; this commit alone is not described as a Wire.
