# 76 Live Room Tool Progress Style And Hot Approval Next

## Date

2026-04-19

## What Changed

This round focused on two concrete improvements:

1. **Codex tool events now bubble up instead of being dropped**
2. **Live room progress rendering is no longer just a generic yellow system pill**

### 1. Codex tool event bubbling

Added:

- `src/lib/real-agents/codex-event-parser.ts`

Updated:

- `src/lib/real-agents/codex-agent.ts`
- `src/lib/remote-harness/ssh-executor.ts`

Behavior now:

- local Codex and remote SSH Codex both parse structured JSON lines
- recognized events are converted into `onToolEvent(...)`
- supported event types:
  - `exec_command_begin`
  - `patch_apply_begin`
  - `web_search_end`
  - `mcp_tool_call_begin`

This means Codex no longer only emits final `agent_message` text. Tool progress now reaches the existing live-room / Feishu progress path.

### 2. Live room progress cards

Updated:

- `src/lib/live-room-delivery.ts`
- `src/components/live-room/LiveRoomWorkspace.tsx`

Behavior now:

- live room delivery posts a structured system message for tool activity:
  - `systemEvent: member_reply_tool`
- existing `member_reply_started` / `member_reply_progress` messages are rendered with a dedicated progress-card style
- tool progress now renders as a compact Hermes-like progress card with:
  - icon / emoji
  - member label
  - tool label
  - preview text
  - animated progress bar

The previous generic yellow full-width system pill remains as fallback for unrelated system messages.

## Verification

Executed:

```bash
npx tsc --noEmit
```

Result:

- passed

## Important Worktree Note

The repository already had unrelated modified / untracked files in the worktree before commit time.

Do **not** blindly commit everything from `git status`.

For this round, the intended file set is:

- `docs/76_LIVE_ROOM_TOOL_PROGRESS_STYLE_AND_HOT_APPROVAL_NEXT.md`
- `skills/karpathy-codex/SKILL.md`
- `src/components/live-room/LiveRoomWorkspace.tsx`
- `src/lib/live-room-delivery.ts`
- `src/lib/real-agents/codex-agent.ts`
- `src/lib/real-agents/codex-event-parser.ts`
- `src/lib/remote-harness/ssh-executor.ts`
- plus the earlier support files from the same thread if you want one combined commit:
  - `src/lib/platform-local-init.ts`
  - `src/app/api/agents/register-real/route.ts`
  - `src/lib/real-agents/index.ts`

## Next Priority: Hot Approval For Current Session

This is the product gap the user explicitly wants next:

- Hermes-style approval that affects the **current blocked session**
- not "approve now, continue later via a new run"
- not "approve and restart into another session"

### Current limitation

Today the approval path is still continuation-based fallback:

- request is persisted
- user resolves it via Feishu
- system tries continuation / rerun

That behavior is documented in:

- `docs/64_FEISHU_APPROVAL_COMMANDS_PHASE1_HANDOVER.md`

This is **not** true in-process unblock.

### Desired target

User expectation:

- agent asks for permission
- user sends `/approve` or taps a card button
- the blocked Codex / Claude process in the current session resumes immediately

### Likely implementation direction

1. Keep durable interaction request persistence
2. Add an in-memory / process-bound approval resolver keyed by the active participant process/session
3. When the user approves:
   - resolve DB state
   - signal the active harness bridge for the same participant
   - feed the approval response back into the current blocked process instead of rerunning
4. Only fall back to continuation when the original process is already gone

### Key rule

Do not market it as "hot approval" unless it resumes the **same active session/process**.

If it starts a fresh continuation run, that is still fallback, not the Hermes behavior the user asked for.
