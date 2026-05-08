# 86 DeepSeek Full-Access Room Profile And Continuation Mismatch Handover

## Date

2026-05-08

## Summary

This batch addressed two ACPX/Feishu integration gaps discovered while testing
DeepSeek in a brand-new Feishu group bound to the local workspace
`/data1/code/deepwiki-open`.

1. `/ap room` did not propagate an explicit full-permission profile into the
   bound live-room source task.
2. After a room was switched from `safe_local` to `full_access`, later
   live-room replies could still resume an older DeepSeek continuation thread
   that had originally been created under `safe_local`.

This produced a misleading result:

- the room UI said `Full Access`
- ACPX run metadata said `full_access`
- but DeepSeek could still behave as if shell approvals were required,
  because it was actually continuing an older restricted thread

The code changes in this batch fix those platform-level issues.

## What Was Fixed

### 1. `/ap room` can now set room permissions explicitly

Updated:

- `src/lib/feishu.ts`
- `src/lib/feishu-live-room.ts`

Added support for:

```text
/ap room --agents=... --profile=safe|dev|full
```

Behavior:

- the selected profile is mapped to ACPX permission config at room-binding time
- the config is written into the bound room's source task
- this also works when reusing an existing Feishu-bound room

Before this fix, room creation always inherited
`DEFAULT_ACPX_PERMISSION_CONFIG`, which is:

- `profile: safe_local`
- `sandboxMode: workspace-write`
- `approvalPolicy: never`

So a newly bound DeepSeek room could still start in safe mode even when the
operator expected full access.

### 2. Continuation reuse is now permission-aware

Updated:

- `src/lib/acpx/session-tracking.ts`
- `src/lib/live-room-delivery.ts`

Before this fix, live-room continuation lookup only cared about:

- participant identity
- task session
- completion/staleness state

It did **not** verify that the historical continuation candidate had been
created under the same effective permission config as the current room.

Effect:

- after upgrading a room from `safe_local` to `full_access`
- ACPX could still resume a previously completed DeepSeek thread created under
  `safe_local`
- that older thread retained runtime flags such as:
  - `allow_shell: false`
  - `trust_mode: false`
  - `auto_approve: false`

The fix now rejects continuation candidates whose recorded `permissionConfig`
does not match the room's current effective permission config.

So a room that is now `full_access` will no longer resume an older
`safe_local` DeepSeek thread.

### 3. DeepSeek runtime failures now surface the real error

Updated:

- `src/lib/real-agents/deepseek-runtime.ts`

Before this fix, failed DeepSeek turns surfaced only a generic message such as:

```text
DeepSeek turn turn_xxx failed
```

Now the runtime forwards the underlying turn error or error-item detail, for
example:

```text
DeepSeek turn turn_xxx failed: SSE stream request failed: HTTP 402 Payment Required: ...
```

This was necessary because later testing showed a second, unrelated failure:
the upstream DeepSeek API account ran out of balance.

## Key Findings From Testing

### Finding 1: Earlier "approval blocked" behavior was partly real

In the Feishu group `deepwiki`, the original room had indeed been created with
`safe_local`, and its first DeepSeek thread was:

- workspace: `/data1/code/deepwiki-open`
- thread id: `thr_12a633b9`
- flags:
  - `allow_shell: false`
  - `trust_mode: false`
  - `auto_approve: false`

So DeepSeek's inability to write in those earlier runs was not purely model
hallucination; the room really was restricted at that stage.

### Finding 2: Later "full access" was real, but old restricted thread was reused

After `/ap room --profile=full`, the room's task-level permission config became
`full_access`, but continuation lookup still reused `thr_12a633b9`.

That is why the room appeared to be full-access while DeepSeek still behaved
like a restricted agent.

### Finding 3: Full-access fresh DeepSeek threads were created successfully

Fresh retry threads were later observed with flags:

- `allow_shell: true`
- `trust_mode: true`
- `auto_approve: true`

So the Phase 2B DeepSeek permission mapping is working for new thread creation.

### Finding 4: The current DeepSeek test is still not complete

After recharging the DeepSeek API once, replies resumed temporarily, but the
upstream DeepSeek API balance was exhausted again during testing.

That means:

- the platform-side permission/profile bugs in this batch have been fixed
- but the intended end-to-end DeepSeek full-access validation for this Feishu
  room is **still not fully completed**
- because the model backend became unavailable before the test loop could be
  closed with stable successful write operations

This point should be stated explicitly to avoid overclaiming test completion.

## Current Status

### Platform / code status

Implemented in code:

- room-time profile propagation for `/ap room`
- permission-aware continuation filtering
- better DeepSeek failure transparency

### Test status

Not fully completed:

- DeepSeek full-access behavior in the target Feishu room was only partially
  validated before the upstream API balance issue returned

### Operational blocker

Current blocker:

- DeepSeek API / upstream model balance instability

## Next Recommended Step

Do **not** treat this DeepSeek test as fully closed yet.

Recommended follow-up:

1. Leave the DeepSeek-side changes in place.
2. When model availability is stable again, retest the same Feishu room and
   confirm that no old `safe_local` thread is reused after `full_access`.
3. In parallel or next, test `claude-haha` on this server as a room agent,
   since that is the next planned harness validation target.

The immediate next agent-side validation should emphasize:

- `claude-haha` can join as a server-local agent
- Feishu room binding works for it
- continuation/session behavior is sane on this server

## Files Changed

- `docs/86_HANDOVER_20260508_DEEPSEEK_FULL_ACCESS_ROOM_PROFILE_AND_CONTINUATION_MISMATCH.md`
- `src/lib/feishu.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/real-agents/deepseek-runtime.ts`

## Verification

Passed:

```bash
npx tsc --noEmit
```

Observed manually during investigation:

- Feishu room task config changed from `safe_local` to `full_access`
- old restricted DeepSeek thread reuse was reproducible before the continuation
  filter fix
- fresh full-access DeepSeek threads were created correctly
- later failures exposed the upstream `402 Payment Required / Insufficient Balance`
  condition
