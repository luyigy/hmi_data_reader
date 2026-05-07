# 82 DeepSeek Platform Local Phase 2A Handover

## Date

2026-05-07

## Summary

Phase 2A of local DeepSeek integration is complete.

DeepSeek no longer runs only as a stateless one-shot `deepseek exec` harness in
ACPX/live-room flows.

This batch upgrades `platform_local + deepseek` to use the local DeepSeek HTTP
runtime so the platform can:

- create a persistent DeepSeek thread
- reuse that same thread across follow-up room messages
- store the DeepSeek thread id in ACPX continuation metadata
- resume the same conversation on later messages instead of starting from
  scratch every time

This is the minimum persistent-session upgrade.

It does **not** yet add full SSE event streaming, tool-event mapping, or real
interrupt semantics.

## What Changed

### 1. Added a DeepSeek runtime client

New file:

- `src/lib/real-agents/deepseek-runtime.ts`

Implemented:

- runtime availability/startup via `deepseek serve -- --http`
- thread creation via `POST /v1/threads`
- turn submission via `POST /v1/threads/:id/turns`
- polling thread state via `GET /v1/threads/:id`
- extraction of final `agent_message` output for the submitted turn

Behavior:

- if the runtime is already running, the client reuses it
- if not, the client starts a local runtime automatically
- new threads can be created with the caller working directory as `workspace`

### 2. DeepSeek local execution now uses persistent threads

Updated:

- `src/lib/real-agents/deepseek-agent.ts`

Implemented:

- `executeDeepSeekTask()` now runs through the HTTP runtime instead of only
  `deepseek exec`
- `resumeDeepSeekSession()` added for continuation on an existing DeepSeek
  thread
- DeepSeek results now return `threadId`

Effect:

- ACPX can launch a fresh DeepSeek thread for the first message
- later ACPX/live-room replies can continue on the same thread

### 3. ACPX runner now persists DeepSeek continuation metadata

Updated:

- `src/lib/acpx/runner.ts`

Implemented:

- `persistDeepSeekThreadMetadata()`
- DeepSeek local branch now supports:
  - fresh execution
  - continuation using `resumeSessionId`

Persisted metadata:

- `deepseekThreadId`
- `lastSessionId`
- `lastSessionKind: deepseek_thread`
- session-tracking root/latest ids

Effect:

- later continuation lookup can find and reuse the latest DeepSeek thread for
  the same participant/session scope

### 4. Session tracking now recognizes DeepSeek threads

Updated:

- `src/lib/acpx/session-tracking.ts`

Implemented:

- DeepSeek continuation session resolution from stored `deepseekThreadId`
- stale-mark cleanup now also clears `deepseekThreadId`

Effect:

- `findLatestParticipantSession()` can now return a reusable DeepSeek
  continuation session

### 5. Continuation fallback now recognizes stale DeepSeek threads

Updated:

- `src/lib/acpx/continuation-retry.ts`
- `src/lib/live-room-delivery.ts`

Implemented:

- invalid DeepSeek continuation detection for errors such as:
  - `Thread not found`
  - failed DeepSeek turn on a stale thread

Effect:

- if a stored DeepSeek thread is stale, the platform can fall back to a fresh
  session path instead of repeatedly retrying a broken continuation

## What This Phase Now Enables

After this batch, DeepSeek in Feishu/live-room should support:

1. first message starts a new DeepSeek thread
2. second and third follow-up messages continue on that same thread
3. the agent can remember prior user-provided context from earlier turns in the
   same room/session

This is the main product-level acceptance target for Phase 2A.

## Still Not Included In Phase 2A

Not implemented yet:

- SSE runtime event streaming into ACPX/live-room
- tool-use event mapping
- robust interrupt/stop delivery to the runtime
- permission-profile mapping to DeepSeek runtime options
- remote SSH DeepSeek runtime support

Current DeepSeek live-room behavior is therefore:

- persistent conversation: yes
- final output return: yes
- rich streaming progress: not yet
- true control semantics: not yet

## Verification

### Type-check verification

Passed:

```bash
npx tsc --noEmit
```

### Runtime-level verification

Confirmed locally with the new runtime wrapper:

1. create a new DeepSeek thread
2. first turn: ask DeepSeek to remember `zebra-441`
3. second turn on the same thread: ask what code it was told to remember

Observed result:

- first turn completed successfully
- second turn returned the same remembered value `zebra-441`

This verifies same-thread continuation works through the new runtime path.

## Required Feishu Test

Before testing:

- restart the running Feishu/runtime service so it picks up the new code

Then test in the same Feishu room with DeepSeek selected:

### Test A: multi-turn continuation

Send:

```text
请记住：我的测试代号是 apple-927。只回复“记住了”。
```

Then:

```text
我的测试代号是什么？
```

Then:

```text
把它倒过来写出来。
```

Expected result:

- DeepSeek remembers `apple-927`
- the third reply continues from prior context instead of behaving like a fresh
  one-shot run

### Test B: fresh session reset

Send:

```text
/ap new-session --handover="docs/82_DEEPSEEK_PLATFORM_LOCAL_PHASE2A_HANDOVER.md" --profile=full "deepseek"
```

Then ask:

```text
我刚才的测试代号是什么？
```

Expected result:

- if the handover does not explicitly carry the old code forward, DeepSeek
  should not continue to remember `apple-927`
- this confirms that fresh-session reset is still working correctly with the
  new DeepSeek continuation model

## Recommended Next Step

Phase 2B should focus on:

1. SSE/runtime event streaming into ACPX/live-room progress
2. optional tool-event mapping if the runtime surfaces enough structured events
3. better stop/interrupt semantics if the runtime supports them cleanly
4. permission-profile mapping for DeepSeek runtime options

## Files In This Batch

- `docs/82_DEEPSEEK_PLATFORM_LOCAL_PHASE2A_HANDOVER.md`
- `src/lib/real-agents/deepseek-runtime.ts`
- `src/lib/real-agents/deepseek-agent.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/acpx/continuation-retry.ts`
- `src/lib/live-room-delivery.ts`
