# 81 Feishu New Session Scope Reset Handover

## Date

2026-05-07

## Summary

This batch fixes the misleading `/ap new-session` behavior where a fresh agent run
was launched, but the same overloaded task-room/task-level context watermark was
still injected into the prompt.

This handover also includes a follow-up continuation bug discovered during
Feishu testing:

- after `/ap new-session`, later live-room replies could still try to resume an
  old Codex thread from a previous session
- that produced errors like:

```text
thread/resume failed: no rollout found for thread id ...
```

That second issue is only **partially addressed** in this batch.
The original task-wide lookup bug was fixed, but real-world Feishu testing still
shows stale Codex thread resume failures after a fresh session has already
started.

Before this fix:

- `/ap new-session` started a fresh agent session
- but the prompt still inherited the old task-room overload state
- so Codex could immediately continue saying the session was overloaded and should
  not keep accumulating context

After this fix:

- `/ap new-session` rotates to a brand new `TaskSession`
- task-room prompt scope resets from a new session-reset marker
- context watermark event counting is scoped to the new `taskSessionId`

## Root Cause

There were two different layers of "session":

1. harness/session continuation at the agent level
2. accumulated task-room + task-run history at the room/task level

The old implementation only refreshed layer 1.
It did not reset layer 2.

So the agent got a fresh run, but the ACPX prompt builder still saw the same
overloaded task-room and the same task-wide event count.

## What Changed

### 1. `/ap new-session` now rotates `TaskSession`

Updated:

- `src/lib/feishu.ts`
- `src/lib/acpx/session.ts`

Added:

- `rotateTaskSession(taskId, options)`

Effect:

- `handleNewSessionCommand()` now creates a new `TaskSession`
- the fresh run uses that new `taskSessionId`
- this makes run-event watermarking start from a fresh session scope

### 2. Task-room prompt scope can reset

Updated:

- `src/lib/task-room.ts`

Added:

- `TASK_ROOM_SESSION_RESET` marker support
- `postTaskRoomSessionResetMarker()`

Effect:

- `/ap new-session` writes a system marker into the task room
- prompt building and room-message counting now only consider messages after the
  latest reset marker
- old room history is preserved in storage, but no longer pollutes the fresh
  prompt scope

### 3. Context watermark event counting is session-scoped

Updated:

- `src/lib/acpx/runner.ts`

Effect:

- `checkContextWatermark()` now counts `TaskRunEvent` by `taskSessionId` when
  available
- it no longer blindly counts the whole task lifetime for a fresh session

### 4. Live-room continuation lookup is now session-scoped

Updated:

- `src/lib/acpx/session-tracking.ts`
- `src/lib/live-room-delivery.ts`

Effect:

- continuation lookup for live-room replies no longer searches across the whole
  `taskId` only
- it is now constrained to the current `taskSessionId` when available
- this removes one confirmed cross-session lookup bug
- however, it does **not** fully eliminate stale Codex resume failures yet

## Follow-up Bug Found During Test

After the first `/ap new-session` fix was deployed and the Feishu runtime was
restarted, a new runtime symptom appeared:

```text
系统提示：codex 正在处理中（stderr）：Error: thread/resume: thread/resume failed:
no rollout found for thread id ...
```

Root cause:

- `/ap new-session` already rotated to a fresh `TaskSession`
- but normal live-room reply delivery still called `findLatestParticipantSession`
  by `taskId`
- so it could pick a continuation thread created under an older session
- Codex then tried to resume that stale thread and failed

Implemented fix:

- `findLatestParticipantSession()` now accepts `taskSessionId`
- live-room delivery now passes the current session id when resolving the latest
  continuation candidate

## Still Unresolved After Fix

Feishu testing still shows this symptom after `/ap new-session` succeeds and the
agent begins responding in the fresh session:

```text
系统提示：codex 正在处理中（stderr）：Error: thread/resume: thread/resume failed:
no rollout found for thread id 019e0131-...
```

Current assessment:

- the original bug was real: continuation lookup was too wide and searched by
  `taskId`
- that path is now narrowed to `taskSessionId`
- despite that, a later live-room reply path is still finding or reusing a stale
  Codex thread id

Later analysis strongly suggests an additional design mismatch:

- `/ap new-session` was launching the fresh run with `ephemeralSession: true`
- that means the bootstrap run was effectively treated like a one-shot fresh run
- but later room replies still expected to resume a persistent Codex thread from
  that new session
- in practice this can lead to `thread/resume failed: no rollout found for thread
  id ...`
- because the thread captured from the bootstrap run is not guaranteed to be
  resumable in the later live-room continuation path

Most likely remaining causes:

1. `sourceTask.currentTaskSession` seen by delivery code is not always the same
   fresh session created by `/ap new-session` at the moment later replies run
2. `LiveRoomMemberSession.threadId` is still carrying an old Codex thread and is
   being reused indirectly after the fresh session bootstrap
3. `/ap new-session` bootstrap may create a non-resumable or effectively
   one-shot Codex run if launched as `ephemeral`
4. there may be another continuation path outside `findLatestParticipantSession`
   that still falls back to stale state

## Additional Fix Applied After This Analysis

Updated:

- `src/lib/feishu.ts`

Change:

- `/ap new-session` no longer launches the target participant as
  `ephemeralSession: true`
- it now starts a fresh **persistent** session for the target agent
- at the same time, matching `LiveRoomMemberSession.threadId` is cleared for that
  room/member to avoid indirect reuse of stale member-level thread state

Expected effect:

- the bootstrap run created by `/ap new-session` should now be a valid new
  continuation root for later room replies
- later replies should no longer try to resume an old or one-shot Codex thread

Latest observed result after applying this fix and restarting the Feishu/runtime
service:

- `/ap new-session` succeeded
- a normal follow-up message in the same room no longer reproduced
  `thread/resume failed: no rollout found for thread id ...`

So this specific stale Codex resume failure now appears resolved in real usage.

## Recommended Debug Plan If The Codex Resume Error Reappears

1. Log the current `taskSessionId` at `/ap new-session` creation time and again
   inside `executeLiveRoomReplyViaAcpx()` before continuation lookup.
2. Log the `latestSession` candidate returned by `findLatestParticipantSession()`
   including participant id, run id, and continuation thread id.
3. Log `LiveRoomMemberSession.threadId` before and after each delivery.
4. If the ids differ, determine whether the stale thread comes from:
   - old `TaskRunParticipant.controlMetadata`
   - `LiveRoomMemberSession.threadId`
   - or stale `currentTaskSession` binding on the task
5. If needed, enforce a stricter rule:
   - after `/ap new-session`, clear member-level stored thread state for that
     room/member
   - and/or temporarily force the first follow-up room reply to run without
     resume

Note:

- the first half of step 5 has now been implemented: member-level stored
  `threadId` is cleared when `/ap new-session` rotates to a fresh session

## Files Changed

- `src/lib/acpx/session.ts`
- `src/lib/task-room.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/feishu.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/live-room-delivery.ts`

## Verification

Passed:

```bash
npx tsc --noEmit
```

## Important Operational Note

You must restart the running Feishu/runtime service before testing this change.

Reason:

- `/ap new-session` is handled by the running server/runtime process
- if Feishu is still attached to an old in-memory build, it will keep using the
  old logic

Because a second runtime fix was added after the first restart, restart the
Feishu/runtime service again before relying on this handover.

## Recommended Test

After restarting the Feishu/runtime service, test in the same previously
overloaded room:

```text
/ap new-session --handover="docs/81_FEISHU_NEW_SESSION_SCOPE_RESET_HANDOVER.md" --profile=full "codex"
```

Expected result:

- Codex reads this handover first
- the new run is attached to a fresh `TaskSession`
- old task-room overload warnings should not immediately reappear just because
  the previous room accumulated too much history
- if the remaining stale-thread path is still present, later live-room replies
  may still fail with `thread/resume failed: no rollout found for thread id ...`
- that remaining issue is not considered closed in this handover

## Workspace Note

`/ap workspace /new/path` already works for an existing Feishu-bound room.

Current behavior:

- updates `LiveRoom.workingDirectory`
- also updates bound `Task.workingDirectory`
- affects future executions in that room
- does not clear old room history by itself

## DeepSeek Note

The repeated DeepSeek reply pattern is still expected to some extent in the
current local Phase 1 design.

This batch does **not** change DeepSeek runtime behavior.

DeepSeek remains Phase 1 one-shot execution only:

- no persistent session continuation
- no HTTP runtime threads
- no streaming/session control mapping yet

To behave like Codex in live room / Feishu chat, DeepSeek needs a later phase
that introduces:

- persistent runtime lifecycle instead of one-shot `deepseek exec`
- stable session/thread identity per room/member
- continuation support across messages
- streaming event mapping into live-room progress and tool events
- interrupt/control semantics where the runtime supports them

Related previous handover:

- `docs/80_DEEPSEEK_PLATFORM_LOCAL_PHASE1_HANDOVER.md`

## DeepSeek Phase 2 Next Move

The next meaningful DeepSeek integration step is **not** prompt tuning.
It is runtime architecture work so DeepSeek can behave like Codex/Claude in
live room and Feishu chat instead of acting like a one-shot subprocess.

Target behavior:

- a DeepSeek member can join a room and keep continuity across messages
- later replies resume the same session/thread identity instead of spawning a
  brand new one-shot run every time
- progress can stream back into live room / Feishu
- if the runtime supports it, interrupt / stop / continue semantics should work

Recommended implementation direction:

1. Add a persistent DeepSeek runtime layer instead of only `deepseek exec`.
2. Prefer an HTTP/service mode if the CLI/runtime supports stable thread reuse.
3. Introduce per-room/per-member session identity for DeepSeek, analogous to how
   Codex/Claude continuation is tracked.
4. Extend ACPX participant/session tracking so DeepSeek can store:
   - session id
   - thread id if the runtime uses one
   - session kind
   - stale/expired markers
5. Add live streaming event mapping:
   - stdout/progress preview
   - tool-use events if available
   - final summary output
6. Add continuation retry/fresh-session fallback rules similar to Codex/Claude.

Minimum concrete Phase 2 deliverables:

- persistent DeepSeek runtime client
- DeepSeek session/thread continuation
- live-room delivery integration with reusable session state
- stale-session detection and fresh-session fallback

Without those changes, DeepSeek will continue to behave like a one-shot worker,
which is why it currently feels repetitive and unlike Codex in chat.

## Context Level / Window Visibility Next Move

There is still no proper user-facing visibility feature for:

- current room context load
- each agent's own session/thread context state
- whether a reply is using fresh session vs continuation

Current implementation only has heuristic watermarking based on:

- task-room message count
- task-run event count
- transcript length

That is useful internally, but it is **not** the same as showing actual context
window/session health to the user.

Recommended feature scope:

1. Show room-level scoped context state.
2. Show per-agent continuation state.
3. Show whether the next reply will use:
   - fresh session
   - continuation
   - stale/expired fallback

Recommended room-level fields:

- current `taskSessionId`
- scoped task-room message count
- scoped task-run event count
- transcript character length
- current working directory

Recommended per-agent fields:

- member name
- harness type
- latest continuation session/thread id
- live-room member session `threadId`
- last error
- session status: online / busy / expired / stale
- last delivery time

Recommended implementation shape:

1. Add a backend status endpoint or extend existing room/task status payloads.
2. Surface the above state in the web UI room panel.
3. Optionally add a lightweight Feishu command such as:
   - `/ap status`
   - `/ap room-status`
   - `/ap context`
4. Make the status clearly distinguish:
   - task-session scope
   - room-member scope
   - agent continuation scope

This feature is still pending and should be treated as a separate workstream
after the new-session/session-continuity fixes.

## Next Recommended Step

1. Restart the Feishu/runtime service.
2. Run the `/ap new-session` test using this handover file.
3. Consider the Feishu `/ap new-session` stale Codex resume issue resolved unless
   it reproduces again under new evidence.
4. Start DeepSeek Phase 2:
   persistent runtime, session continuation, and live-room streaming/control.
5. Start the context visibility feature so room/session health is inspectable.
6. A useful first cut is a small status readout for:
   - current `taskSessionId`
   - scoped room message count
   - scoped event count
   - current workspace path
