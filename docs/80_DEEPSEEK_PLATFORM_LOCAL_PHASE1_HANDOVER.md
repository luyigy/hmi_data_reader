# 80 DeepSeek Platform Local Phase 1 Handover

## Date

2026-05-07

## Summary

Phase 1 of local DeepSeek integration is complete.

`deepseek-tui` is now wired into the project as a `platform_local` harness using:

```bash
deepseek exec -- --json "<prompt>"
```

This gives the platform a minimum usable DeepSeek agent without yet introducing
runtime HTTP threads, session continuation, or streaming event mapping.

## What Changed

### 1. Added a local DeepSeek executor

New file:

- `src/lib/real-agents/deepseek-agent.ts`

Implemented:

- `isDeepSeekAvailable()`
- `getDeepSeekVersion()`
- `executeDeepSeekTask()`

Behavior:

- launches `deepseek exec -- --json`
- parses JSON result
- returns final text output to the existing local harness flow

### 2. Registered DeepSeek as a real/local agent type

Updated:

- `src/lib/real-agents/index.ts`
- `src/lib/platform-local-init.ts`
- `src/app/api/agents/register-real/route.ts`

Effects:

- local status now reports `deepseek`
- platform-local bootstrap now creates a `deepseek` agent for the current host
- registration/status API now exposes DeepSeek availability and version

### 3. Exposed DeepSeek in the catalog and runner

Updated:

- `src/lib/acpx/catalog.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/capabilities.ts`
- `src/lib/feishu.ts`

Effects:

- DeepSeek appears in local catalog output
- live-room / ACPX can execute it as `platform_local`
- initial capability profile is conservative and matches one-shot execution
- local status mapping in Feishu now recognizes `deepseek`

## Verification

### Command-level verification

Confirmed on this machine:

- `deepseek --version`
- `deepseek doctor --json`
- `deepseek exec -- --json 'Reply with exactly: phase1-ok'`

Observed successful JSON output:

```json
{
  "mode": "one-shot",
  "model": "deepseek-v4-pro",
  "success": true,
  "output": "phase1-ok"
}
```

### Type-check verification

Passed:

```bash
npx tsc --noEmit
```

### Product-level verification

Confirmed:

- web/API catalog on port `3010` shows `platform_local:platform-local:deepseek`
- `/api/agents/register-real` reports `deepseek: true`
- DeepSeek was successfully added to the live room
- user-reported `DeepSeek smoke test` passed

### Important operational note

During verification, web/API and Feishu runtime were briefly out of sync:

- web server had the new DeepSeek catalog entry
- Feishu runtime still held an older in-memory catalog

This explained the temporary:

```text
Unknown agent ids: platform_local:platform-local:deepseek
```

Once the correct runtime picked up the updated code, room add and smoke test succeeded.

## Current Scope / Limitations

This batch intentionally stops at Phase 1.

Not implemented yet:

- DeepSeek session continuation
- runtime HTTP thread management
- SSE event streaming
- tool-use event mapping
- remote SSH DeepSeek support
- ACPX permission-model alignment beyond conservative defaults

Current capability profile is intentionally minimal:

- no queued-user-message semantics
- no resume-after-interrupt semantics
- no live-session control semantics

## Recommended Next Step

Phase 2 should introduce a persistent runtime client based on:

```bash
deepseek serve -- --http --host 127.0.0.1 --port <port>
```

That phase should focus on:

1. thread creation and reuse
2. continuation/session persistence
3. event streaming into live-room / ACPX
4. interrupt and control semantics if the runtime supports them cleanly

## Files In This Batch

- `docs/79_DEEPSEEK_TUI_PLATFORM_LOCAL_INTEGRATION_PLAN.md`
- `docs/80_DEEPSEEK_PLATFORM_LOCAL_PHASE1_HANDOVER.md`
- `src/app/api/agents/register-real/route.ts`
- `src/lib/acpx/capabilities.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/feishu.ts`
- `src/lib/platform-local-init.ts`
- `src/lib/real-agents/deepseek-agent.ts`
- `src/lib/real-agents/index.ts`
