# 96 Pi Agent Integration Plan

## Date

2026-05-19

## Status

Phase 1 implemented in this repository.

Platform-local smoke test succeeded after service restart:

- `pi-agent` appears in `/ap agents`
- it can be added into the current room
- room conversation with `pi-agent` executes successfully

## Goal

Add `pi agent` to this project in a way that matches the new harness architecture direction from:

- [88_HARNESS_ADAPTER_FRAMEWORK_DESIGN.md](/data1/code/agent-platform-v2/docs/88_HARNESS_ADAPTER_FRAMEWORK_DESIGN.md)
- [89_HARNESS_ADAPTER_INTERFACE_DRAFT.md](/data1/code/agent-platform-v2/docs/89_HARNESS_ADAPTER_INTERFACE_DRAFT.md)

The target is not another one-off `if/else` integration.
The target is: `pi agent` should join the platform as one more registered harness adapter.

## Current Conclusion

`pi agent` should be integrated after the new `HarnessAdapter + registry` entry path, not by copying the old pre-adapter pattern used when `codex/claude` were first added.

That means the right shape is:

1. add one `pi-agent` adapter
2. add one `real-agents/pi-agent.ts` executor wrapper
3. register it in the harness registry
4. expose it through local status, platform-local bootstrap, catalog, and ACPX/live-room

## What Was Confirmed

### 1. The project already had a clear architectural direction

Docs `88` and `89` explicitly define the intended direction:

- platform logic should stop knowing each CLI's details
- harness-specific differences should live inside adapters
- continuation invalidation patterns should be owned by the adapter
- capabilities and permission support should be declared by the adapter

### 2. The codebase now has the first-stage adapter entry points

This repo now has:

- `src/lib/harness/types.ts`
- `src/lib/harness/registry.ts`
- `src/lib/harness/adapters/*`

That is the correct insertion point for `pi agent`.

### 3. The actual local launch entry is now known

Confirmed runnable entry:

```bash
/data1/code/pi-mono/pi-test.sh --version
```

Observed version:

```text
0.74.0
```

Confirmed CLI capabilities:

- `--print`
- `--mode json`
- `--continue`
- `--session-dir`
- `--no-session`
- `--extension`
- `--provider`
- `--model`

This means Pi can be integrated as a normal local CLI harness.

## Implemented Shape

The repo now includes:

- `src/lib/real-agents/pi-agent.ts`
- `src/lib/harness/adapters/pi-agent.ts`
- `src/lib/harness/registry.ts`
- `src/lib/real-agents/index.ts`
- `src/lib/platform-local-init.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/acpx/runner.ts`
- `src/app/api/agents/register-real/route.ts`

The integration path is:

1. platform-local discovery sees `pi-agent`
2. catalog exposes it as a selectable local harness
3. ACPX runner dispatches through the harness adapter registry
4. Pi executes via `/data1/code/pi-mono/pi-test.sh`
5. continuation uses stable dedicated `session-dir` storage

## Recommended Integration Shape

## Phase 1: Minimal Usable `platform_local + pi-agent`

Status:

- implemented
- validated in live-room flow

Objective:

- make Pi selectable as a local harness
- allow ACPX/live-room to run a prompt and collect final output
- avoid over-promising session semantics until the CLI/runtime is verified

Recommended files:

- `src/lib/real-agents/pi-agent.ts`
- `src/lib/harness/adapters/pi-agent.ts`
- `src/lib/real-agents/index.ts`
- `src/lib/platform-local-init.ts`
- `src/lib/acpx/catalog.ts`
- `src/app/api/agents/register-real/route.ts`

### Expected adapter contract

Suggested harness key:

```ts
'pi-agent'
```

Suggested adapter responsibilities:

- `checkAvailability()`
- `execute()`
- `resume()` only if Pi really supports session continuation
- `getCapabilities()`
- `getPermissionSupport()`
- `readContinuation()`
- `isInvalidContinuationError()`

### Suggested local executor contract

`src/lib/real-agents/pi-agent.ts` should mirror the existing wrappers:

- `isPiAgentAvailable()`
- `getPiAgentVersion()`
- `executePiAgentTask()`
- `resumePiAgentSession()` only if Pi supports it

## Phase 1 launch command
Current implementation:

```bash
/data1/code/pi-mono/pi-test.sh --print ...
```

Supported override:

```bash
PI_AGENT_BIN=/absolute/path/to/pi-test.sh
```

The repository currently defaults to `/data1/code/pi-mono/pi-test.sh`.

## Output-mode requirement

Before implementing Phase 1, Pi must satisfy at least one of these:

1. non-interactive one-shot prompt mode
2. structured JSON output mode
3. stable plain-text mode that can be wrapped defensively

If Pi only supports an interactive fullscreen TUI, it should not be integrated by terminal scraping as the primary path.

## Phase 2: Session / Continuation

Phase 1 already includes a conservative continuation path:

- store a stable dedicated `session-dir`
- resume with `--continue`

What is still not implemented:

- richer event streaming from Pi JSON mode into ACPX tool/progress events
- stronger interrupt semantics
- precise permission mapping to Pi internal tool/runtime controls

## Capability Recommendation

Implemented capability stance:

```ts
{
  supportsQueuedUserMessages: true,
  supportsImmediateInterrupt: false,
  supportsResumeAfterInterrupt: true,
  supportsLiveSessionControl: false,
  supportsSoftStop: true,
}
```

## Permission Recommendation

Do not guess Pi permission semantics.

Current behavior:

- record ACPX permission config into run metadata
- expose support as `recorded_only`
- do not claim Pi permission mapping parity with Codex or DeepSeek yet

## Validation Result

Validated successfully:

1. Pi executable availability check
2. platform-local registration visibility
3. `/ap agents` visibility after restart
4. add-to-room flow
5. room conversation execution

Still recommended to test separately:

1. multi-turn continuation robustness over longer rooms
2. file modification behavior under real coding tasks
3. tool/progress event UX
4. custom provider / extension loading from platform-managed env

## Concrete Implementation Order

1. Confirm the exact Pi launch command on this machine
2. Verify a one-shot prompt can run non-interactively
3. Verify whether structured output exists
4. Implement `src/lib/real-agents/pi-agent.ts`
5. Implement `src/lib/harness/adapters/pi-agent.ts`
6. Register the adapter in `src/lib/harness/registry.ts`
7. Add platform-local discovery/bootstrap/catalog exposure
8. Run ACPX/live-room end-to-end smoke tests
9. Iterate on continuation, streaming, and permission alignment

## What Should Not Be Done

### 1. Do not add Pi by scattering branches again

Avoid this pattern:

- add `if (harnessType === 'pi-agent')` in runner
- add another copy in continuation retry
- add another copy in live-room invalidation
- add another copy in permissions

That would directly fight the architecture docs.

### 2. Do not pretend Pi has session semantics before proving it

If Pi does not expose a real resumable session, keep it one-shot first.

### 3. Do not rely on terminal scraping unless there is no other path

If Pi has a headless or API mode, use that.

## Recommended Continuation Shape

Pi JSON print mode emits a session header with `id`, but not the absolute session file path.
So for ACPX, the safer continuation strategy is:

1. assign each participant a stable dedicated `session-dir`
2. persist that directory as continuation identity
3. resume with:

```bash
pi --print --session-dir <dir> --continue "<message>"
```

This avoids depending on one specific session file path.
