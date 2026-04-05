# 64 Feishu Approval Commands Phase 1 Handover

## Date
2026-04-05

## Goal

Deliver the first usable Feishu approval bridge slice on top of the new ACPX interaction-request persistence layer.

This phase does not fully complete interactive in-process harness resume.

It does complete:

- durable storage of harness interaction requests
- Feishu commands to inspect and resolve them
- a Codex/Claude-friendly continuation fallback path for approve/answer
- a deny path that cleanly resolves and stops the blocked run

## What Was Added

### 1. Persistent interaction request model

New Prisma model:

- `TaskRunInteractionRequest`

Files:

- `prisma/schema.prisma`
- `prisma/migrations/20260405124000_add_task_run_interaction_requests/migration.sql`

Stored fields include:

- task / run / participant linkage
- request kind
- status
- raw payload
- response text / metadata
- requested / resolved timestamps

### 2. ACPX interaction service layer

New file:

- `src/lib/acpx/interactions.ts`

Provides:

- create request
- dedupe lookup for recent pending request
- list pending requests
- fetch by id
- resolve request
- expire stale requests

### 3. Runner persistence hooks

Updated:

- `src/lib/acpx/runner.ts`
- `src/lib/acpx/types.ts`

When harness stdout/stderr matches an interaction prompt:

- runner persists a `TaskRunInteractionRequest`
- runner still marks run / participant as `waiting_for_input`
- runner emits:
  - `interaction_request_created`
  - existing `control_message` with `interactionRequestId`

This keeps current UI behavior compatible while making the request durable.

### 4. Resolution action service

New file:

- `src/lib/acpx/interaction-actions.ts`

Current behavior:

- `deny`
  - resolves request as denied
  - marks participant / run failed
  - emits resolution event
- `approve` / `answer`
  - resolves request
  - attempts continuation using the existing ACPX continuation path
  - emits resolution metadata, including resume success/failure

This is a continuation fallback, not true in-process stdin reply yet.

### 5. Feishu commands

Updated:

- `src/lib/feishu.ts`

New commands:

- `/ap approvals`
- `/ap approve <id>`
- `/ap deny <id> [reason]`
- `/ap answer <id> <text>`

Current lookup rule:

- bound Feishu room -> source task -> pending requests for that task
- request id can be full id or last 8 chars

## Verification Done

### Local end-to-end command verification

Using the real DB context of the currently bound Feishu room:

1. inserted a synthetic pending `permission_request`
2. invoked `/ap approvals` through `handleFeishuCommand(...)`
3. invoked `/ap deny <id> test-deny` through `handleFeishuCommand(...)`
4. verified request row changed to:
   - `status = denied`
   - `responseText = test-deny`

Observed result:

```text
Pending approvals
- trccvbki | permission_request | Test pending approval from local script
```

and:

```text
✅ approval trccvbki 已拒绝
类型：permission_request
状态：denied
当前未自动继续会话。
```

### Runtime safety checks

- Feishu standalone runtime restarts on latest code
- Prisma schema validates
- Prisma client regenerated with `taskRunInteractionRequest` delegate present
- local `prisma/dev.db` was migrated so this workspace can execute the new path

## Important Limitation

Phase 1 does **not** implement true live in-process harness reply yet.

Current approve/answer behavior is:

- resolve request in DB
- try to continue using the existing ACPX continuation mechanism

This is good enough for Codex-first rollout, but later phases should support:

- real stdin-style reply when harness capability allows it

## Files In This Phase

- `docs/63_FEISHU_HARNESS_APPROVAL_BRIDGE_PLAN.md`
- `docs/64_FEISHU_APPROVAL_COMMANDS_PHASE1_HANDOVER.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260405124000_add_task_run_interaction_requests/migration.sql`
- `src/lib/acpx/types.ts`
- `src/lib/acpx/interactions.ts`
- `src/lib/acpx/interaction-actions.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/feishu.ts`

## DB Commit Guidance

Commit:

- schema
- migration
- code

Do not commit:

- `prisma/dev.db`

Reason:

- `dev.db` is local mutable environment state
- migration file is the source of truth for schema evolution
- committing local sqlite state makes history noisy and machine-specific

