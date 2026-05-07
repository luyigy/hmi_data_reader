# 85 DeepSeek Phase 2B Streaming and Permission Mapping Handover

## Date

2026-05-07

## Summary

This batch extends the local DeepSeek runtime integration beyond the Phase 2A
baseline in `82`.

Two practical gaps are addressed:

1. DeepSeek no longer waits until turn completion to emit all visible progress.
2. ACPX permission profiles now affect how a **new DeepSeek thread** is
   created, so `full_access` can actually run shell tools instead of silently
   falling back to Python-only behavior.

This is intentionally incremental. It does **not** implement full token-level
text streaming, and it does **not** hot-update permissions for already-existing
DeepSeek threads.

## Why This Batch Was Needed

After `82`, DeepSeek had persistent thread continuation, but two missing
product behaviors remained:

### Gap 1: Only final output was visible

`runDeepSeekRuntimeTurn()` polled thread state and only extracted the final
completed `agent_message`.

Effect:

- live room received the final answer
- Feishu/live-room progress did **not** see tool use or status changes during
  execution

### Gap 2: ACPX permission config was ignored

Unlike Codex, the DeepSeek local harness path did not consume:

- `sandboxMode`
- `approvalPolicy`

So even if the user launched:

```text
/ap new-session --profile=full "deepseek"
```

the new DeepSeek thread still used runtime defaults such as:

- `allow_shell: true`
- `trust_mode: false`
- `auto_approve: false`

Observed consequence:

- `exec_shell` denied
- `task_shell_start` denied
- Python/code execution still available

From the user point of view, this looked like "full access was granted but
DeepSeek still cannot really use shell".

## What Changed

### 1. Runtime item polling now emits progress events

Updated:

- `src/lib/real-agents/deepseek-runtime.ts`

Added item-consumption during polling:

- track unseen item ids per turn
- convert newly observed runtime items into stream callbacks immediately

Current mapping:

- `tool_call` → `onToolEvent`
- `command_execution` → `onToolEvent`
- `status` → `onStdoutChunk`
- failed `command_execution` → `onStderrChunk`

Effect:

- live room can show DeepSeek tool progress before final completion
- Feishu progress tracker can now receive DeepSeek tool events via the existing
  callback chain

Important limit:

- this is **event-level streaming**, not token-level final-answer streaming
- final natural-language answer still arrives at turn completion

## 2. Added a dedicated DeepSeek runtime item parser

New file:

- `src/lib/real-agents/deepseek-event-parser.ts`

Responsibilities:

- normalize DeepSeek runtime tool names to platform tool labels
- derive progress previews from DeepSeek item summary/detail payloads
- extract status text for progress streaming

Examples:

- `read_file` → `Read`
- `exec_shell` / `command_execution` → `Bash`
- `apply_patch` → `Edit`

This keeps DeepSeek-specific parsing out of the generic runtime polling loop.

## 3. Permission profile mapping now applies to new DeepSeek threads

Updated:

- `src/lib/real-agents/deepseek-agent.ts`
- `src/lib/real-agents/deepseek-runtime.ts`
- `src/lib/acpx/runner.ts`

Implemented:

- DeepSeek local execution now accepts:
  - `sandboxMode`
  - `approvalPolicy`
- these are mapped into thread-creation fields:
  - `allow_shell`
  - `trust_mode`
  - `auto_approve`

Current mapping:

### `full_access`

When ACPX permission config is effectively:

- `sandboxMode: danger-full-access`
- `approvalPolicy: on-request`

the created DeepSeek thread now uses:

- `allow_shell: true`
- `trust_mode: true`
- `auto_approve: true`

Result:

- shell tools can execute without the runtime blocking on approval

### `dev_local`

When permission config is effectively:

- `sandboxMode: workspace-write`
- `approvalPolicy: on-request`

the created DeepSeek thread now uses:

- `allow_shell: true`
- `trust_mode: false`
- `auto_approve: false`

Result:

- shell is not fully unlocked
- behavior remains more restricted than `full_access`

### `safe_local`

When permission config is effectively:

- `sandboxMode: workspace-write`
- `approvalPolicy: never`

the created DeepSeek thread now uses:

- `allow_shell: false`
- `trust_mode: false`
- `auto_approve: false`

Result:

- conservative default behavior

## 4. Permission support summary now reflects real DeepSeek behavior

Updated:

- `src/lib/acpx/permissions.ts`

Before:

- DeepSeek was described as `recorded_only`

Now:

- DeepSeek is described as `partially_applied`
- because new-thread shell/approval behavior is now really mapped
- but network access / writable roots are still metadata-only

## Files Changed In This Batch

- `docs/85_HANDOVER_20260507_DEEPSEEK_PHASE2B_STREAMING_AND_PERMISSION_MAPPING.md`
- `src/lib/real-agents/deepseek-event-parser.ts`
- `src/lib/real-agents/deepseek-runtime.ts`
- `src/lib/real-agents/deepseek-agent.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/permissions.ts`

## Verification

### 1. Type-check

Passed:

```bash
npx tsc --noEmit
```

### 2. Runtime capability check: thread creation flags

Verified directly against the local DeepSeek runtime:

- `POST /v1/threads` accepts:
  - `allow_shell`
  - `trust_mode`
  - `auto_approve`

Observed created thread state reflected those values correctly.

### 3. Runtime behavior check: which flag actually unlocks shell

Tested `Run pwd in the shell and reply with only the directory path.`

Observed:

- `trust_mode: true` alone was **not enough**
- `auto_approve: true` was the key flag that allowed `exec_shell` to succeed

This was the main evidence for mapping `full_access` to `auto_approve: true`.

### 4. End-to-end code-path check through `executeDeepSeekTask()`

Verified:

- `danger-full-access + on-request`
  - returned the shell path result successfully
- `workspace-write + on-request`
  - remained more restricted than full access

### 5. Event streaming check

Verified via local script against the runtime wrapper:

- a DeepSeek turn emitted tool progress such as:

```text
TOOL Read :: agent-platform-v2
```

before the final answer was returned.

This confirms the new callback path is working.

## Important Operational Notes

### 1. Service restart required

The running app/service must be restarted before live-room testing, otherwise
the old DeepSeek integration code stays in memory.

### 2. New-thread-only permission application

Permission mapping is applied when a DeepSeek thread is **created**.

It does **not** reconfigure an already-existing thread during continuation.

Implication:

- if an old restricted thread already exists, it may continue to behave with
  old permissions
- to validate `full_access`, use a fresh DeepSeek session/thread

Recommended test:

```text
/ap new-session --profile=full "deepseek"
```

then:

```text
请用 shell 执行 `pwd`，只回复当前目录路径。
```

Expected result:

- the new DeepSeek thread should be able to use shell directly

## What This Batch Still Does Not Solve

Not implemented here:

- token-level final-answer streaming from DeepSeek runtime
- true live approval bridge for DeepSeek shell requests
- hot permission escalation for an already-running DeepSeek thread
- explicit mapping of `networkAccess`
- explicit mapping of `writableRoots`

## Recommended Next Step

If we continue DeepSeek alignment after this batch, the next practical step
should be:

1. investigate whether the runtime exposes richer incremental final-text events
2. if not, keep event-level streaming and focus next on continuation-aware
   permission escalation semantics
3. separately keep `83` / `84` as the architecture track for future
   per-agent session isolation, since `new-session` still resets task-shared
   context rather than true per-agent context

## Related Documents

- `docs/82_DEEPSEEK_PLATFORM_LOCAL_PHASE2A_HANDOVER.md`
- `docs/83_HANDOVER_20260404_NEW_SESSION_PER_AGENT_ISOLATION.md`
- `docs/84_设计_20260404_房间消息三层可见性与会话隔离.md`
