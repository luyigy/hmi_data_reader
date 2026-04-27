# 77 Session Permission Override For Hot Approval

## Date

2026-04-19

## What Changed

This round implemented a **session-scoped permission override** so approvals and grants affect the
**current task session**, instead of only mutating the task default config for some later run.

Updated files:

- `src/lib/acpx/permissions.ts`
- `src/lib/acpx/session.ts`
- `src/lib/acpx/interaction-actions.ts`
- `src/lib/feishu-grant.ts`
- `src/lib/feishu.ts`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/api/tasks/[id]/execute/route.ts`

## New Behavior

### 1. Task session now carries an effective permission override

`TaskSession.metadata` now stores:

- `sessionPermissionConfig`
- `sessionPermissionSource`
- `sessionPermissionUpdatedAt`

This makes permission escalation part of the task session state, not just a one-off argument passed
to a single continuation call.

### 2. `/approve` on permission-style interaction now escalates the current session

In `resolveInteractionRequestWithContinuation(...)`:

- when the request kind is `permission_request` or `workspace_issue`
- and the user approves it

the platform now:

1. computes the effective current permission config for the task session
2. escalates it to `full_access`
3. writes that config into `TaskSession.metadata`
4. starts continuation using that same session-scoped config

So the approval is no longer just "resume once with a temporary config"; the current task session
remembers the granted permission level.

### 3. `/ap grant ...` now updates the current session, not only task defaults

`grantRightsForRoom(...)` now writes the granted permission into the current task session override
before starting continuation.

This means the grant is effective for the active task session immediately.

### 4. `execute` and `continue_session` now prefer session override over task default

The runtime now resolves effective permission config in this order:

1. `TaskSession.metadata.sessionPermissionConfig`
2. `Task.acpxPermissionConfig`
3. `DEFAULT_ACPX_PERMISSION_CONFIG`

This was the missing piece. Without it, the grant/approval could be written, but later runs inside
the same session could still accidentally fall back to the old task-level config.

## Product Meaning

This gets us much closer to the Hermes expectation in the way that actually matters operationally:

- the user approves once
- the current task session becomes elevated
- the follow-up continuation keeps using that elevated permission

So the permission grant is now **session-hot**, not merely "persist for some future unrelated run".

## Important Limitation

This is still **not true in-process stdin resume**.

The current local harness launch model still works like this:

- Codex writes the prompt and then closes stdin
- Claude runs with stdin ignored

So there is still no mechanism to feed a permission answer directly back into the already-blocked
OS process.

That means:

- current session permission is now hot-updated
- continuation stays in the same task session / same Codex thread when available
- but the blocked process itself is not literally resumed in-place

## Verification

Executed:

```bash
npx tsc --noEmit
```

Result:

- passed

## Next Gap If We Want True Hermes-Style `/approve`

To reach actual in-process unblock behavior, we still need:

1. harness launch with a live stdin bridge
2. approval request registry keyed to the active participant process
3. a resolver that can deliver the approval back into the same blocked process
4. continuation only as fallback when that original process is gone
