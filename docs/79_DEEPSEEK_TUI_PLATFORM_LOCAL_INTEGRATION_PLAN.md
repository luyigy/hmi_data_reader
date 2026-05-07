# 79 DeepSeek-TUI Platform Local Integration Plan

## Date

2026-05-07

## Goal

Add `deepseek-tui` as a first-class `platform_local` agent in this project, with a path that is:

- usable quickly
- compatible with current ACPX/live-room orchestration
- upgradeable from one-shot execution to resumable session execution

This document is a planning and handover note. No code changes are included in this batch.

## Current State

The local machine already has `deepseek` installed and configured:

- binary: `/home/hello/.local/bin/deepseek`
- version: `0.8.14`
- `deepseek doctor --json` succeeds
- config path: `/home/hello/.deepseek/config.toml`
- default model: `deepseek-v4-pro`

Validated commands:

```bash
deepseek exec -- --json 'Reply with exactly: pong'
```

Observed output:

```json
{
  "mode": "one-shot",
  "model": "deepseek-v4-pro",
  "success": true,
  "output": "pong"
}
```

Validated local runtime spawn:

```bash
deepseek serve -- --http --host 127.0.0.1 --port 7788
```

Observed startup output:

```text
Runtime API listening on http://127.0.0.1:7788
Security: this server is local-first. Do not expose it to untrusted networks.
```

Validated runtime API reachability:

```bash
curl -sS -X POST http://127.0.0.1:7788/v1/threads \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Observed result: thread creation succeeds and returns a thread id such as `thr_a567cddc`.

## Key Conclusion

`deepseek-tui` should not be integrated as a fragile screen-scraped TUI harness.

Recommended strategy:

1. Phase 1: integrate `deepseek` as a `platform_local` one-shot harness via `deepseek exec -- --json`
2. Phase 2: upgrade to persistent session orchestration via `deepseek serve -- --http`

This is the lowest-risk path because it matches the current project structure:

- Phase 1 is close to current `codex`/`claude` local child-process execution
- Phase 2 unlocks real continuation, interrupt, and session semantics instead of trying to fake them

## Why This Needs Real Work

The project currently treats local harnesses as mostly known concrete integrations, not a generic pluggable CLI layer.

Confirmed hard-coded areas:

- `src/lib/real-agents/index.ts`
  - local status only covers `codex`, `claude`, `claude-haha`
- `src/lib/platform-local-init.ts`
  - default platform-local agent registration only creates those three agents
- `src/lib/acpx/runner.ts`
  - `platform_local` execution only branches into `codex` or `claude` logic
- `src/lib/remote-harness/ssh-executor.ts`
  - remote SSH execution only supports `codex` and `claude`
- `src/lib/acpx/capabilities.ts`
  - capability model is specialized for existing harnesses
- `src/lib/acpx/permissions.ts`
  - launch-time permission application only meaningfully maps to `codex`

So the answer is not “just add one database row”. A real integration needs execution, status, catalog, session, and capability wiring.

## Recommended Delivery Plan

### Phase 1: Minimum Usable `platform_local + deepseek`

Objective:

- expose DeepSeek as a local selectable agent
- allow ACPX/live-room runs to execute prompts successfully
- return final text output

Implementation shape:

- add a new local harness type: `deepseek`
- create `src/lib/real-agents/deepseek-agent.ts`
- implement:
  - `isDeepSeekAvailable()`
  - `getDeepSeekVersion()`
  - `executeDeepSeekTask()`
- execution command:

```bash
deepseek exec -- --json "<prompt>"
```

Expected behavior:

- no true resume yet
- no strong interrupt semantics yet
- no tool-stream event mapping yet
- good enough to make it appear and run as a local agent

Files expected in this phase:

- `src/lib/real-agents/deepseek-agent.ts` (new)
- `src/lib/real-agents/index.ts`
- `src/lib/platform-local-init.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/capabilities.ts`
- `src/lib/acpx/types.ts`
- `src/app/api/agents/register-real/route.ts`

### Phase 2: Resumable `platform_local + deepseek` Runtime

Objective:

- make DeepSeek behave like a persistent local agent rather than a stateless command

Implementation shape:

- spawn or connect to:

```bash
deepseek serve -- --http --host 127.0.0.1 --port <port>
```

- create a runtime client wrapper, for example:
  - `src/lib/real-agents/deepseek-runtime.ts`
- use runtime endpoints for:
  - thread creation
  - turn submission
  - event streaming
  - resume/fork/read as needed

Expected gains:

- real continuation semantics
- thread id persistence
- cleaner ACPX session mapping
- possible future interrupt support if runtime events/actions support it

Files expected in this phase:

- `src/lib/real-agents/deepseek-runtime.ts` (new)
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/acpx/continuation-retry.ts`
- `src/lib/acpx/liveness.ts`

### Phase 3: Permission and Interaction Alignment

Objective:

- map ACPX permission profiles to DeepSeek runtime options in a principled way

Possible fields to align:

- `sandboxMode`
- `approvalPolicy`
- shell/tool enablement
- trust/auto-approve flags

Notes:

- current ACPX permission model is written around Codex-like semantics
- DeepSeek permission semantics should be mapped explicitly, not guessed

### Phase 4: Optional `remote_ssh + deepseek`

Objective:

- allow remote hosts to expose DeepSeek as a remote SSH harness

Recommendation:

- do not run the visual TUI remotely and scrape it
- either:
  - use `deepseek exec -- --json` remotely for simple one-shot runs
  - or start remote `deepseek serve -- --http` and call that service through SSH-managed infrastructure

## Exact Recommended Order

1. Add `deepseek` to local availability/status and platform-local registration
2. Add `executeDeepSeekTask()` based on `deepseek exec -- --json`
3. Wire `platform_local + deepseek` into `acpx/runner.ts`
4. Expose it through catalog and registration APIs
5. Mark capabilities conservatively for Phase 1
6. Verify end-to-end in ACPX and live room
7. Only then build the persistent runtime client

This order keeps the first milestone small and demonstrable.

## Phase 1 Capability Recommendation

Conservative capability flags for initial `deepseek` support:

- `supportsQueuedUserMessages: false`
- `supportsImmediateInterrupt: false`
- `supportsResumeAfterInterrupt: false`
- `supportsLiveSessionControl: false`
- `supportsSoftStop: true`

Reason:

- Phase 1 is a short-lived child process around `deepseek exec`
- it should not pretend to have session features that are not actually wired

After Phase 2, these can be revisited.

## Main Risks

### 1. Output Format Stability

Phase 1 relies on `deepseek exec -- --json` output staying stable enough to parse.

Mitigation:

- parse strictly but defensively
- keep raw stderr in failure paths

### 2. Session Semantics Mismatch

Current ACPX continuation logic already has harness-specific assumptions for `codex` and `claude`.

Mitigation:

- do not over-promise continuation in Phase 1
- add a dedicated DeepSeek runtime/session path in Phase 2

### 3. Permission Model Drift

DeepSeek’s approval/sandbox behavior is not identical to Codex.

Mitigation:

- Phase 1 should record permissions but only apply the subset that is confidently supported

### 4. Live Streaming Expectations

Current user experience in live room expects visible progress for some harnesses.

Mitigation:

- Phase 1 can be final-output-only if needed
- Phase 2 should use runtime event streaming for proper incremental updates

## Suggested Verification Plan

### Phase 1 Verification

1. `deepseek --version`
2. `deepseek doctor --json`
3. API route for real-agent registration reports DeepSeek available
4. DeepSeek appears in harness catalog
5. ACPX task with `platform_local + deepseek` completes successfully
6. Live room can route a message to DeepSeek and receive a final answer
7. `npx tsc --noEmit`

### Phase 2 Verification

1. runtime server starts reliably
2. thread creation succeeds
3. a second turn continues the same thread
4. ACPX stores and reuses DeepSeek thread/session identity
5. live room continuation uses the same session

## Open Questions Before Implementation

1. Should the first delivered version be:
   - fast and simple (`exec --json`)
   - or slower but semantically better (`serve --http`)?
2. Should DeepSeek be shown as:
   - a generic `deepseek`
   - or a more specific label like `deepseek-tui`?
3. Do we want Phase 1 to include live streaming, or is final-output-only acceptable?
4. Is `remote_ssh + deepseek` in scope now, or only after local support is stable?

## Recommended Next Step

Start with Phase 1 and explicitly keep it small:

- add `deepseek` as a visible `platform_local` agent
- execute through `deepseek exec -- --json`
- wire final output into ACPX/live-room
- defer persistent runtime/session work until after first end-to-end success

This gives a working DeepSeek agent quickly without locking the project into the wrong abstraction.

## External References

- DeepSeek-TUI repository:
  - `https://github.com/Hmbown/DeepSeek-TUI`
- Runtime API documentation:
  - `https://github.com/Hmbown/DeepSeek-TUI/blob/main/docs/RUNTIME_API.md`

## Files Modified In This Batch

- `docs/79_DEEPSEEK_TUI_PLATFORM_LOCAL_INTEGRATION_PLAN.md`
