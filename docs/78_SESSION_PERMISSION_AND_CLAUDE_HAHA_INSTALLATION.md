# 78 Session Permission Override + Claude-Haha Multi-Installation

## Date

2026-04-27

## What Changed

Two major features in this batch:

### 1. Session-Scoped Permission Override (Hot Approval)

Previously, `/ap grant` and `/approve` only mutated the task-level `acpxPermissionConfig`. Continuations
inside the same session could fall back to the old task-level config. Now the effective permission is
stored in `TaskSession.metadata` and takes precedence over task defaults.

Updated files:

- `src/lib/acpx/session.ts` — added `resolveTaskSessionPermissionConfig()`, `setTaskSessionPermissionOverride()`, `readTaskSessionPermissionOverride()`
- `src/lib/acpx/interaction-actions.ts` — approval of permission_request/workspace_issue now escalates session to `full_access` and persists the override
- `src/lib/acpx/permissions.ts` — added `buildAcpxPermissionConfigForProfile()` helper
- `src/lib/acpx/feishu-grant.ts` — `/ap grant` writes into session override instead of task-level config
- `src/app/api/tasks/[id]/control/route.ts` — `continue_session` resolves permission from session override
- `src/app/api/tasks/[id]/execute/route.ts` — new runs also prefer session override; `execute` action writes override when explicit config provided
- `src/lib/feishu.ts` — updated help text and status messages to reflect session-hot behavior

Permission resolution order:
1. `TaskSession.metadata.sessionPermissionConfig`
2. `Task.acpxPermissionConfig`
3. `DEFAULT_ACPX_PERMISSION_CONFIG`

### 2. Claude-Haha Multi-Installation Support

Added support for running multiple Claude CLI installations (e.g., `claude` and `claude-haha`) with
separate binaries, HOME dirs, and config directories.

New file:

- `src/lib/real-agents/claude-installations.ts` — registry of known installations, `resolveClaudeInstallation()`, `isClaudeHarnessType()`

Updated files:

- `src/lib/real-agents/claude-agent.ts` — `executeClaudeTask`, `resumeClaudeSession`, `isClaudeAvailable`, `getClaudeVersion` all accept `harnessType` param; spawns correct binary; sets HOME and CLAUDE_CONFIG_DIR per installation
- `src/lib/acpx/catalog.ts` — recognizes `claude-haha` as distinct harness type (not lumped with `claude`)
- `src/lib/acpx/runner.ts` — uses `isClaudeHarnessType()` for timeout/launch branching

### 3. CLAUDE.md Behavioral Guidelines

Added coding guidelines (simplicity first, surgical changes, goal-driven execution) to project CLAUDE.md.

## Product Meaning

- Approving a permission request now makes the **current task session** elevated — subsequent continuations keep that permission
- `/ap grant` is session-hot, not just "persist for some future run"
- Users can run tasks with `claude-haha` harness to use a separate Claude installation with its own config

## Known Limitation

Permission escalation is session-hot but not in-process stdin resume. The blocked OS process is not
literally unblocked — a new continuation run picks up the elevated permission instead.

## Verification

```bash
npx tsc --noEmit
```

Passed.

## Files Committed

- `CLAUDE.md`
- `docs/77_SESSION_PERMISSION_OVERRIDE_FOR_HOT_APPROVAL.md`
- `src/lib/real-agents/claude-installations.ts` (new)
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/api/tasks/[id]/execute/route.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/acpx/interaction-actions.ts`
- `src/lib/acpx/permissions.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/session.ts`
- `src/lib/feishu-grant.ts`
- `src/lib/feishu.ts`
- `src/lib/real-agents/claude-agent.ts`

## Not Committed (intentionally excluded)

- `.env` — contains secrets (FEISHU_APP_SECRET)
- `prisma/dev.db` / `dev.db` — binary database files
- `.codex/` — config directory
- `logs/` / `nohup.out` — runtime artifacts
