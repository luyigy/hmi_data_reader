# 87 Gemini Platform Local Integration Plan

## Date

2026-05-09

## Goal

Add `gemini-cli` as a first-class `platform_local` agent in this project, with a path that is:

- immediately usable in ACPX and live room
- compatible with current local harness orchestration
- able to reuse Gemini session continuation from day one

This document is a planning and handover note for the implementation batch that follows.

## Current State

The local machine already has Gemini CLI installed and reachable:

- binary: `/home/hello/.local/bin/gemini`
- version: `0.41.2`

Validated commands:

```bash
printf 'Reply with exactly: gemini-ok\n' \
  | gemini --prompt '' --output-format stream-json --approval-mode yolo --skip-trust
```

Observed output shape:

```json
{"type":"init","session_id":"cbed3e41-2f06-484d-8076-a9948733175f","model":"auto-gemini-3"}
{"type":"message","role":"assistant","content":"gemini-ok","delta":true}
{"type":"result","status":"success"}
```

Validated continuation:

```bash
printf 'What was the exact token you replied with previously? Reply with that token only.\n' \
  | gemini --prompt '' --output-format stream-json --approval-mode yolo --skip-trust \
      --resume cbed3e41-2f06-484d-8076-a9948733175f
```

Observed result: Gemini replied `gemini-ok`, proving that:

- `session_id` can be captured from `init`
- `--resume <session_id>` works for the current workspace

## Key Conclusion

Gemini should be integrated as a normal `platform_local` direct harness, not as a fake gateway alias.

Unlike the earlier DeepSeek Phase 1 path, Gemini already exposes enough CLI surface to support:

1. headless execution
2. stream-json parsing
3. session continuation

So the minimum useful implementation can include continuation support from the start.

## Why This Needs Real Work

The repository currently has only partial Gemini awareness:

- `src/lib/acpx/types.ts`
  - includes `gemini-cli` in the harness type union
- `src/lib/acpx/catalog.ts`
  - normalizes `gemini*` names to `gemini-cli`

But the real local execution path is still hard-coded for other harnesses:

- `src/lib/platform-local-init.ts`
  - no local Gemini agent bootstrap
- `src/lib/real-agents/index.ts`
  - no Gemini availability/version reporting
- `src/lib/acpx/runner.ts`
  - no `platform_local + gemini-cli` execution branch
- `src/lib/acpx/capabilities.ts`
  - no Gemini capability profile
- `src/lib/acpx/permissions.ts`
  - no Gemini permission support summary
- `src/lib/feishu.ts`
  - local harness availability mapping does not recognize Gemini
- `src/app/api/agents/register-real/route.ts`
  - local registration/status API does not expose Gemini

So “just letting the room choose Gemini” would be incomplete. The agent must also be discoverable, runnable, resumable, and visible in status APIs.

## Recommended Delivery Plan

### Phase 1: Minimum Usable `platform_local + gemini-cli`

Objective:

- expose Gemini as a local selectable agent
- allow ACPX/live-room runs to execute prompts successfully
- return final text output
- persist Gemini session ids for continuation

Implementation shape:

- add a new local harness type: `gemini-cli`
- create `src/lib/real-agents/gemini-agent.ts`
- implement:
  - `isGeminiAvailable()`
  - `getGeminiVersion()`
  - `executeGeminiTask()`
  - `resumeGeminiSession()`

Execution command:

```bash
printf '<prompt>' | gemini --prompt '' --output-format stream-json --approval-mode yolo --skip-trust
```

Continuation command:

```bash
printf '<prompt>' | gemini --prompt '' --output-format stream-json --approval-mode yolo --skip-trust --resume <session_id>
```

Expected behavior:

- stream assistant deltas into existing stdout flow
- capture `session_id` from the `init` event
- store it as continuation metadata
- allow later `continue_session` to reuse the same Gemini session

Files expected in this phase:

- `src/lib/real-agents/gemini-agent.ts` (new)
- `src/lib/real-agents/index.ts`
- `src/lib/platform-local-init.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/capabilities.ts`
- `src/lib/acpx/permissions.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/feishu.ts`
- `src/app/api/agents/register-real/route.ts`

### Phase 2: Permission and Interaction Alignment

Objective:

- map ACPX permission profiles to Gemini launch flags conservatively

Notes:

- Gemini has its own `--sandbox` and `--approval-mode` vocabulary
- the current ACPX permission model is not one-to-one with Gemini CLI
- first batch should map only what is safe and obvious, and record the rest in metadata

### Phase 3: Optional `remote_ssh + gemini-cli`

Objective:

- allow remote hosts to expose Gemini over SSH

Notes:

- catalog normalization already accepts `gemini*`
- but remote executor and Remote SSH UI do not yet support Gemini
- this should be a separate batch after local execution is proven stable

## Exact Recommended Order

1. Add Gemini local executor with stream-json parsing and session capture
2. Add Gemini to local status and platform-local bootstrap
3. Wire `platform_local + gemini-cli` into `acpx/runner.ts`
4. Track Gemini session ids in ACPX continuation metadata
5. Expose Gemini through registration/status and Feishu local status mapping
6. Verify end-to-end in catalog, live room, and continuation flow
