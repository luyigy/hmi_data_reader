# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Execution status

Use these labels for task-route tickets in Agent Platform, Reader, and Model. Preserve unrelated labels such as `bug` or `enhancement`.

| Label | Apply when |
| --- | --- |
| `ready-for-agent` | The ticket is specified, its prerequisites have passed, and execution has not started. |
| `in-progress` | An implementation or repair is running. |
| `in-review` | Implementation is integrated and checks or independent review are running. |
| `blocked` | Execution has stopped on a named blocker, or unfinished prerequisites prevent it from starting. |
| `done` | The approved completion conditions have passed and the Issue is closed. |

These execution labels are mutually exclusive. Remove a stale `ready-for-agent` label when applying another execution label. Keep the five Matt triage roles above; do not globally rename the shared `ready-for-agent` label to `blocked`.

For `blocked`, distinguish the active failure from downstream dependency waiting in the Issue's status comment. Use `needs-info` only when the reporter really must supply information; an Agent's report of missing material is not sufficient if the material can be retrieved from an already approved source. Use `ready-for-human` only when human implementation is needed.

The execution ledger determines status. Labels do not grant permission, approve a route, resume a task, or replace its dependency links. Label edits must leave Issue titles, bodies and dependency metadata unchanged.

Current automation synchronizes completion comments and closes finished Issues. It does not maintain these execution labels. Until that support exists, reconcile labels from the current ledger when reporting route status; do not claim labels are continuously synchronized.
